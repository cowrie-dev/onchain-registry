// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @title SanctionsResolver
/// @notice EAS schema resolver that mirrors the active sanctioning attestation per recipient.
/// @dev    Sanctioned status is encoded by attestation presence: an active (non-revoked) attestation
///         from a trusted attester means the recipient is sanctioned.  Owner manages the
///         trusted-attester allowlist; mutations only flow through EAS.
contract SanctionsResolver is SchemaResolver, Ownable {
    struct Designation {
        bytes32 attestationUID; // bytes32(0) means not sanctioned
        address attester;
        uint64 attestedAt;
    }

    mapping(address => Designation) private _designations;
    mapping(address => bool) public trustedAttesters;

    event AttesterTrusted(address indexed attester, bool trusted);
    event Sanctioned(address indexed account, address indexed attester, bytes32 uid);
    event Unsanctioned(address indexed account, bytes32 uid);

    constructor(IEAS eas, address initialAttester) SchemaResolver(eas) Ownable(msg.sender) {
        if (initialAttester != address(0)) {
            trustedAttesters[initialAttester] = true;
            emit AttesterTrusted(initialAttester, true);
        }
    }

    /// @notice Add or remove an attester from the allowlist.
    /// @param attester Address whose trust is being toggled.
    /// @param trusted  True to grant, false to revoke.
    function setAttesterTrust(address attester, bool trusted) external onlyOwner {
        trustedAttesters[attester] = trusted;
        emit AttesterTrusted(attester, trusted);
    }

    /// @notice Returns the EAS contract address this resolver is bound to.
    function getEAS() external view returns (address) {
        return address(_eas);
    }

    /// @notice Returns the active designation recorded for an account.
    /// @param account The address to look up.
    function getDesignation(address account) external view returns (Designation memory) {
        return _designations[account];
    }

    /// @notice Chainalysis-compatible single-address sanctioned check.
    /// @param account Address to check.
    /// @return True iff there is a non-revoked attestation from a trusted attester for this address.
    function isSanctioned(address account) external view returns (bool) {
        return _designations[account].attestationUID != bytes32(0);
    }

    /// @notice Batch sanctioned check.
    /// @param accounts Addresses to check.
    /// @return out One bool per input, same order.
    function isSanctionedBatch(address[] calldata accounts) external view returns (bool[] memory out) {
        out = new bool[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            out[i] = _designations[accounts[i]].attestationUID != bytes32(0);
        }
    }

    function onAttest(Attestation calldata att, uint256 /*value*/) internal override returns (bool) {
        if (!trustedAttesters[att.attester]) {
            return false;
        }

        _designations[att.recipient] = Designation({
            attestationUID: att.uid,
            attester: att.attester,
            attestedAt: uint64(block.timestamp)
        });
        emit Sanctioned(att.recipient, att.attester, att.uid);
        return true;
    }

    function onRevoke(Attestation calldata att, uint256 /*value*/) internal override returns (bool) {
        // Only clear state if this UID is the currently active one for the recipient.
        // Stale revocations of superseded attestations are silent no-ops (last-write semantics).
        if (_designations[att.recipient].attestationUID == att.uid) {
            delete _designations[att.recipient];
            emit Unsanctioned(att.recipient, att.uid);
        }
        return true;
    }
}
