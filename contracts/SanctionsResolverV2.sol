// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice OFAC account registry with the original Chainalysis read ABI.
/// @dev Non-EVM strings must use the published canonical form, or the exact
///      source string when OFAC lists a value that cannot be decoded.
contract SanctionsResolverV2 is SchemaResolver, OwnableUpgradeable, UUPSUpgradeable {
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.AddressSet;

    string public constant SCHEMA = "bytes32 network,string account,string source,string sourceUID,string category,string sourceUrl,bytes32 sourceSha256,uint64 sourcePublishedAt,uint64 designatedAt";
    bytes32 public constant EVM = bytes32("EVM");
    // Proxy storage: preserve existing fields and append new fields in future implementations.
    bytes32 public schemaUID;

    struct Designation { bytes32 attestationUID; address attester; uint64 attestedAt; }
    mapping(bytes32 => Designation) internal _designations;
    mapping(address => bool) public trustedAttesters;
    EnumerableSet.Bytes32Set internal _keys;
    EnumerableSet.AddressSet internal _evmAccounts;

    event AttesterTrusted(address indexed attester, bool trusted);
    event AccountSanctioned(bytes32 indexed key, bytes32 indexed network, string account, address attester, bytes32 uid);
    event AccountUnsanctioned(bytes32 indexed key, bytes32 uid);
    event Sanctioned(address indexed account, address indexed attester, bytes32 uid);
    event Unsanctioned(address indexed account, bytes32 uid);
    error UnsupportedNetwork(bytes32 network);
    error InvalidAccount();

    /// @dev EAS is fixed in each implementation; deploy upgrades with the same EAS address.
    constructor(IEAS eas) SchemaResolver(eas) {
        _disableInitializers();
    }

    /// @notice Called atomically by the ERC1967Proxy constructor.
    function initialize(address initialOwner, address initialAttester) external initializer {
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        schemaUID = keccak256(abi.encodePacked(SCHEMA, address(this), true));
        if (initialAttester != address(0)) {
            trustedAttesters[initialAttester] = true;
            emit AttesterTrusted(initialAttester, true);
        }
    }


    /// @dev A final implementation may override this hook to permanently reject upgrades.
    function _authorizeUpgrade(address) internal virtual override onlyOwner {}

    function getEAS() external view returns (address) { return address(_eas); }
    function setAttesterTrust(address attester, bool trusted) external onlyOwner {
        trustedAttesters[attester] = trusted;
        emit AttesterTrusted(attester, trusted);
    }

    function supportsNetwork(bytes32 network) public pure returns (bool) {
        return network == EVM || network == bytes32("BTC") || network == bytes32("BCH")
            || network == bytes32("BTG") || network == bytes32("BSV") || network == bytes32("LTC")
            || network == bytes32("DASH") || network == bytes32("ZEC") || network == bytes32("XVG")
            || network == bytes32("XMR") || network == bytes32("XRP") || network == bytes32("TRX")
            || network == bytes32("SOL") || network == bytes32("DOGE") || network == bytes32("BNB");
    }

    /// @notice Hash a canonical account. EVM hex casing is normalized here.
    function accountKey(bytes32 network, string memory account) public pure returns (bytes32) {
        if (!supportsNetwork(network)) revert UnsupportedNetwork(network);
        if (bytes(account).length == 0) revert InvalidAccount();
        if (network == EVM) {
            (bool valid, address evmAccount) = _tryEvm(account);
            if (valid) return _evmKey(evmAccount);
        }
        return keccak256(abi.encode(network, account));
    }
    function _tryEvm(string memory account) internal pure returns (bool, address) {
        if (bytes(account).length != 42 || bytes(account)[0] != "0" || bytes(account)[1] != "x") return (false, address(0));
        return Strings.tryParseAddress(account);
    }
    function _evmKey(address account) internal pure returns (bytes32) {
        return keccak256(abi.encode(EVM, account));
    }

    // Do not overload or change this signature: Chainalysis integrators use it verbatim.
    function isSanctioned(address account) external view returns (bool) {
        return _designations[_evmKey(account)].attestationUID != bytes32(0);
    }
    function isSanctionedBatch(address[] calldata accounts) external view returns (bool[] memory out) {
        out = new bool[](accounts.length);
        for (uint256 i; i < accounts.length; ++i) out[i] = _designations[_evmKey(accounts[i])].attestationUID != bytes32(0);
    }
    function getDesignation(address account) public view virtual returns (Designation memory) { return _designations[_evmKey(account)]; }
    function isSanctionedAccount(bytes32 network, string calldata account) external view returns (bool) {
        return _designations[accountKey(network, account)].attestationUID != bytes32(0);
    }
    function isSanctionedKey(bytes32 key) external view returns (bool) { return _designations[key].attestationUID != bytes32(0); }
    function isSanctionedKeyBatch(bytes32[] calldata keys) external view returns (bool[] memory out) {
        out = new bool[](keys.length);
        for (uint256 i; i < keys.length; ++i) out[i] = _designations[keys[i]].attestationUID != bytes32(0);
    }
    function getDesignationByKey(bytes32 key) public view virtual returns (Designation memory) { return _designations[key]; }
    function sanctionedCount() external view returns (uint256) { return _evmAccounts.length(); }
    function sanctionedAddresses() external view returns (address[] memory) { return _evmAccounts.values(); }
    function sanctionedAccountCount() external view returns (uint256) { return _keys.length(); }
    /// @notice Paginate at a fixed block because removal changes enumeration order.
    function sanctionedKeyRange(uint256 offset, uint256 limit) external view returns (bytes32[] memory out) {
        uint256 count = _count(_keys.length(), offset, limit);
        out = new bytes32[](count);
        for (uint256 i; i < count; ++i) out[i] = _keys.at(offset + i);
    }
    function sanctionedRange(uint256 offset, uint256 limit) external view returns (address[] memory out) {
        uint256 count = _count(_evmAccounts.length(), offset, limit);
        out = new address[](count);
        for (uint256 i; i < count; ++i) out[i] = _evmAccounts.at(offset + i);
    }
    function _count(uint256 total, uint256 offset, uint256 limit) private pure returns (uint256) {
        if (offset >= total) return 0;
        return limit < total - offset ? limit : total - offset;
    }

    function onAttest(Attestation calldata att, uint256) internal virtual override returns (bool) {
        if (!trustedAttesters[att.attester] || att.schema != schemaUID || !att.revocable || att.expirationTime != 0) return false;
        (bytes32 network, string memory account) = abi.decode(att.data, (bytes32, string));
        bytes32 key = accountKey(network, account);
        (bool validEvm, address evmAccount) = network == EVM ? _tryEvm(account) : (false, address(0));
        if (att.recipient != evmAccount) return false;
        _designations[key] = Designation(att.uid, att.attester, uint64(block.timestamp));
        _keys.add(key);
        if (validEvm) {
            _evmAccounts.add(evmAccount);
            emit Sanctioned(evmAccount, att.attester, att.uid);
        }
        emit AccountSanctioned(key, network, account, att.attester, att.uid);
        return true;
    }
    function onRevoke(Attestation calldata att, uint256) internal virtual override returns (bool) {
        if (att.schema != schemaUID) return false;
        (bytes32 network, string memory account) = abi.decode(att.data, (bytes32, string));
        bytes32 key = accountKey(network, account);
        if (_designations[key].attestationUID == att.uid) {
            delete _designations[key];
            _keys.remove(key);
            (bool validEvm, address evmAccount) = network == EVM ? _tryEvm(account) : (false, address(0));
            if (validEvm) {
                _evmAccounts.remove(evmAccount);
                emit Unsanctioned(evmAccount, att.uid);
            }
            emit AccountUnsanctioned(key, att.uid);
        }
        return true;
    }
}
