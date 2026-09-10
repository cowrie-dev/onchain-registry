// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { SanctionsResolverV2 } from "./SanctionsResolverV2.sol";
import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @notice Publication-based implementation for the existing V2 UUPS proxy.
contract SanctionsPublicationResolver is SanctionsResolverV2 {
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.AddressSet;

    string public constant PUBLICATION_SCHEMA = "string source,string sourceUrl,bytes32 sourceSha256,bytes32 comparisonSourceSha256,uint64 sourcePublishedAt,bytes32 previousPublication,uint8 kind,uint32 chunkIndex,uint32 chunkCount,string[] sourceUIDs,string[] categories,uint64[] designatedAt,string[] entityNetworks,string[] addedAccounts,uint32[] entityIndices,string[] removedNetworks,string[] removedAccounts";

    struct Publication {
        string source;
        string sourceUrl;
        bytes32 sourceSha256;
        bytes32 comparisonSourceSha256;
        uint64 sourcePublishedAt;
        bytes32 previousPublication;
        uint8 kind; // 0 bootstrap, 1 publication, 2 correction/reconciliation
        uint32 chunkIndex;
        uint32 chunkCount;
        string[] sourceUIDs;
        string[] categories;
        uint64[] designatedAt;
        string[] entityNetworks;
        string[] addedAccounts;
        uint32[] entityIndices;
        string[] removedNetworks;
        string[] removedAccounts;
    }
    struct PublicationState {
        bytes32 firstUID;
        bytes32 lastUID;
        bytes32 sourceSha256;
        uint64 sourcePublishedAt;
        uint32 processedChunks;
        uint32 chunkCount;
        uint8 kind;
        uint32 addedKeys;
        uint32 removedKeys;
    }
    struct ChunkAuthor { address attester; uint64 attestedAt; }

    // Append only: the complete deployed V2 storage layout is inherited above.
    bool public publicationsEnabled;
    bytes32 public latestPublication;
    bytes32 public pendingPublication;
    mapping(bytes32 => PublicationState) public publications;
    mapping(bytes32 => ChunkAuthor) private _chunkAuthors;

    event PublicationChunkApplied(bytes32 indexed publicationId, bytes32 indexed uid, uint32 chunkIndex);
    event PublicationCompleted(bytes32 indexed publicationId, bytes32 indexed sourceSha256, uint64 sourcePublishedAt, uint8 kind, uint32 addedKeys, uint32 removedKeys);
    error InvalidPublication();
    error InvalidPublicationOrder();
    error RegistryAlreadyPopulated();

    constructor(IEAS eas) SanctionsResolverV2(eas) {}

    /// @notice Activate during upgradeToAndCall; owner/trust and all old slots stay intact.
    function initializePublications() external reinitializer(2) onlyOwner {
        if (_keys.length() != 0) revert RegistryAlreadyPopulated();
        publicationsEnabled = true;
        schemaUID = keccak256(abi.encodePacked(PUBLICATION_SCHEMA, address(this), false));
    }

    /// @dev EAS fields are a flat ABI tuple. Prefix its offset to decode a Solidity struct.
    function _decode(bytes memory data) private pure returns (Publication memory) {
        return abi.decode(bytes.concat(bytes32(uint256(32)), data), (Publication));
    }

    function publicationId(Publication memory p) public pure returns (bytes32) {
        return keccak256(abi.encode(p.source, p.sourceUrl, p.sourceSha256, p.comparisonSourceSha256,
            p.sourcePublishedAt, p.previousPublication, p.kind, p.chunkCount));
    }

    /// @notice Standard typed output, including all original account strings and entity metadata.
    function getPublicationChunk(bytes32 uid) public view returns (Publication memory) {
        Attestation memory att = _eas.getAttestation(uid);
        if (!publicationsEnabled || att.schema != schemaUID) revert InvalidPublication();
        return _decode(att.data);
    }

    function getDesignation(address account) public view override returns (Designation memory) {
        return getDesignationByKey(_evmKey(account));
    }
    function getDesignationByKey(bytes32 key) public view override returns (Designation memory) {
        bytes32 uid = _designations[key].attestationUID;
        if (!publicationsEnabled) return _designations[key];
        ChunkAuthor memory author = _chunkAuthors[uid];
        return Designation(uid, author.attester, author.attestedAt);
    }

    /// @notice Read the active source spelling without a custom binary decoder.
    /// @dev Scans one bounded publication chunk; strings are stored only in EAS.
    function getAccountByKey(bytes32 key) external view returns (string memory network, string memory account, string memory sourceUID) {
        bytes32 uid = _designations[key].attestationUID;
        if (uid == bytes32(0)) return ("", "", "");
        Publication memory p = getPublicationChunk(uid);
        for (uint256 i; i < p.addedAccounts.length; ++i) {
            if (accountKey(_network(p.entityNetworks[p.entityIndices[i]]), p.addedAccounts[i]) == key) {
                return (p.entityNetworks[p.entityIndices[i]], p.addedAccounts[i], p.sourceUIDs[p.entityIndices[i]]);
            }
        }
        revert InvalidPublication();
    }

    function _network(string memory name) private pure returns (bytes32 network) {
        bytes memory raw = bytes(name);
        if (raw.length == 0 || raw.length > 32) revert InvalidPublication();
        assembly ("memory-safe") { network := mload(add(raw, 32)) }
        // Require the exact published network name; embedded NUL aliases are not names.
        if (keccak256(raw) != keccak256(bytes(_networkName(network)))) revert InvalidPublication();
        if (!supportsNetwork(network)) revert UnsupportedNetwork(network);
    }
    function _networkName(bytes32 network) private pure returns (string memory) {
        uint256 length;
        while (length < 32 && network[length] != 0) ++length;
        bytes memory name = new bytes(length);
        for (uint256 i; i < length; ++i) name[i] = network[i];
        return string(name);
    }

    function onAttest(Attestation calldata att, uint256 value) internal override returns (bool) {
        if (!publicationsEnabled) return super.onAttest(att, value);
        if (!trustedAttesters[att.attester] || att.schema != schemaUID || att.revocable
            || att.expirationTime != 0 || att.recipient != address(0) || att.refUID != bytes32(0) || value != 0) return false;
        Publication memory p = _decode(att.data);
        _validate(p);
        bytes32 id = publicationId(p);
        PublicationState storage state = publications[id];
        if (p.previousPublication != latestPublication || p.chunkIndex != state.processedChunks
            || (pendingPublication != bytes32(0) && pendingPublication != id)
            || (state.chunkCount != 0 && state.processedChunks == state.chunkCount)) revert InvalidPublicationOrder();
        if (p.chunkIndex == 0) {
            if ((latestPublication == bytes32(0)) != (p.kind == 0)) revert InvalidPublicationOrder();
            if (latestPublication != bytes32(0) && p.sourcePublishedAt < publications[latestPublication].sourcePublishedAt) revert InvalidPublicationOrder();
            state.firstUID = att.uid;
            state.sourceSha256 = p.sourceSha256;
            state.sourcePublishedAt = p.sourcePublishedAt;
            state.chunkCount = p.chunkCount;
            state.kind = p.kind;
            pendingPublication = id;
        }
        _chunkAuthors[att.uid] = ChunkAuthor(att.attester, uint64(block.timestamp));
        // Removal first also makes a remove-and-readd correction explicit.
        for (uint256 i; i < p.removedAccounts.length; ++i) _remove(p.removedNetworks[i], p.removedAccounts[i], att.uid);
        for (uint256 i; i < p.addedAccounts.length; ++i) _add(p.entityNetworks[p.entityIndices[i]], p.addedAccounts[i], att);
        state.addedKeys += uint32(p.addedAccounts.length);
        state.removedKeys += uint32(p.removedAccounts.length);
        state.lastUID = att.uid;
        ++state.processedChunks;
        emit PublicationChunkApplied(id, att.uid, p.chunkIndex);
        if (state.processedChunks == state.chunkCount) {
            latestPublication = id;
            pendingPublication = bytes32(0);
            emit PublicationCompleted(id, state.sourceSha256, state.sourcePublishedAt, state.kind, state.addedKeys, state.removedKeys);
        }
        return true;
    }

    function _validate(Publication memory p) private pure {
        uint256 adds = p.addedAccounts.length;
        uint256 removes = p.removedAccounts.length;
        if (bytes(p.source).length == 0 || bytes(p.sourceUrl).length == 0 || p.sourceSha256 == bytes32(0)
            || p.sourcePublishedAt == 0 || p.kind > 2 || p.chunkCount == 0 || p.chunkIndex >= p.chunkCount
            || adds + removes == 0 || adds > type(uint32).max || removes > type(uint32).max
            || p.sourceUIDs.length != p.entityNetworks.length || adds != p.entityIndices.length
            || removes != p.removedNetworks.length || p.sourceUIDs.length != p.categories.length
            || p.sourceUIDs.length != p.designatedAt.length || (p.kind == 0 && removes != 0)) revert InvalidPublication();
        for (uint256 i; i < adds; ++i) if (p.entityIndices[i] >= p.sourceUIDs.length) revert InvalidPublication();
    }
    function _add(string memory name, string memory account, Attestation calldata att) private {
        bytes32 network = _network(name);
        bytes32 key = accountKey(network, account);
        if (_designations[key].attestationUID != bytes32(0)) revert InvalidPublication();
        _designations[key].attestationUID = att.uid;
        _keys.add(key);
        if (network == EVM) {
            (bool valid, address evmAccount) = _tryEvm(account);
            if (valid) { _evmAccounts.add(evmAccount); emit Sanctioned(evmAccount, att.attester, att.uid); }
        }
        emit AccountSanctioned(key, network, account, att.attester, att.uid);
    }
    function _remove(string memory name, string memory account, bytes32 uid) private {
        bytes32 network = _network(name);
        bytes32 key = accountKey(network, account);
        if (_designations[key].attestationUID == bytes32(0)) revert InvalidPublication();
        delete _designations[key];
        _keys.remove(key);
        if (network == EVM) {
            (bool valid, address evmAccount) = _tryEvm(account);
            if (valid) { _evmAccounts.remove(evmAccount); emit Unsanctioned(evmAccount, uid); }
        }
        emit AccountUnsanctioned(key, uid);
    }
    function onRevoke(Attestation calldata att, uint256 value) internal override returns (bool) {
        if (!publicationsEnabled) return super.onRevoke(att, value);
        return false;
    }
}
