// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

// solhint-disable no-unused-import
import { EAS } from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import { SchemaRegistry } from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
// solhint-enable no-unused-import

/// @dev Empty contract whose sole purpose is to drag EAS + SchemaRegistry into the build for tests.
contract EASImports {}
