// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { SanctionsResolverV2, IEAS } from "../SanctionsResolverV2.sol";

contract SanctionsResolverV2UpgradeMock is SanctionsResolverV2 {
    uint256 public revisionValue;

    constructor(IEAS eas) SanctionsResolverV2(eas) {}

    // Called atomically through ProxyAdmin.upgradeAndCall in the migration test.
    function initializeRevision(uint256 value) external reinitializer(2) {
        revisionValue = value;
    }
}
