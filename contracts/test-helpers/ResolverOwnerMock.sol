// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SanctionsResolverV2 } from "../SanctionsResolverV2.sol";

// Models a governance contract exercising the resolver owner interface.
contract ResolverOwnerMock is Ownable {
    constructor(address owner) Ownable(owner) {}

    function setAttesterTrust(SanctionsResolverV2 resolver, address attester, bool trusted) external onlyOwner {
        resolver.setAttesterTrust(attester, trusted);
    }

    function transferResolverOwnership(SanctionsResolverV2 resolver, address nextOwner) external onlyOwner {
        resolver.transferOwnership(nextOwner);
    }
}
