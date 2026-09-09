// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { SanctionsResolverV2, IEAS } from "../SanctionsResolverV2.sol";

// Models a final upgrade that preserves administration while permanently disabling upgrades.
contract SanctionsResolverV2FrozenMock is SanctionsResolverV2 {
    error UpgradesDisabled();

    constructor(IEAS eas) SanctionsResolverV2(eas) {}

    function _authorizeUpgrade(address) internal pure override {
        revert UpgradesDisabled();
    }
}
