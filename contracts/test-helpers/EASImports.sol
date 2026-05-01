// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import { EAS as EASBase } from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import { SchemaRegistry as SchemaRegistryBase } from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import { ISchemaRegistry } from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";

/// @dev Thin local wrapper so Hardhat emits a standalone artifact for EAS (required by viem.deployContract).
contract EAS is EASBase {
    constructor(ISchemaRegistry registry) EASBase(registry) {}
}

/// @dev Thin local wrapper so Hardhat emits a standalone artifact for SchemaRegistry (required by viem.deployContract).
contract SchemaRegistry is SchemaRegistryBase {}
