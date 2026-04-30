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

    /// @notice Returns the EAS contract address this resolver is bound to.
    function getEAS() external view returns (address) {
        return address(_eas);
    }

    function onAttest(Attestation calldata, uint256) internal pure override returns (bool) {
        return false;
    }

    function onRevoke(Attestation calldata, uint256) internal pure override returns (bool) {
        return true;
    }
}
