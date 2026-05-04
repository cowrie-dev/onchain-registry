// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title CreateXHarness
/// @notice Test fixture mirroring the production CreateX contract
///         (https://createx.rocks, deployed at 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed
///         on every major chain) for the permissioned-salt CREATE3 path used by
///         our deploy script.  Exists to test address-prediction parity in
///         hardhat without mocking out CreateX.
///
///         This harness ONLY supports the salt mode our scripts use:
///           salt[0:20]  == msg.sender (permissioned)
///           salt[20]    == 0x00       (no cross-chain replay protection)
///         Other modes revert.  CreateX's full implementation supports four
///         modes; we don't need them here.
contract CreateXHarness {
    error InvalidSalt();
    error ProxyDeployFailed();
    error InitCodeCallFailed();
    error NoCodeAtDeployedAddress();

    /// @notice Deploys `initCode` via CREATE3 at a salt-derived address.
    /// @dev Address depends on (this harness, salt, msg.sender) only; init code
    ///      does NOT affect the resulting address (that's the point of CREATE3).
    function deployCreate3(bytes32 salt, bytes calldata initCode) external returns (address deployed) {
        if (address(bytes20(salt)) != msg.sender) revert InvalidSalt();
        if (salt[20] != 0x00) revert InvalidSalt();

        bytes32 guardedSalt = keccak256(
            abi.encodePacked(bytes32(uint256(uint160(msg.sender))), salt)
        );

        // CreateX's CREATE3 proxy: pushes 8-byte runtime "363d3d37363d34f0",
        // returns it.  When the proxy is later called with calldata, the runtime
        // does CREATE(0, 0, calldatasize, calldata) -> deploys the target.
        bytes memory proxyBytecode = hex"67363d3d37363d34f03d5260086018f3";
        address proxy;
        assembly {
            proxy := create2(0, add(proxyBytecode, 0x20), mload(proxyBytecode), guardedSalt)
        }
        if (proxy == address(0)) revert ProxyDeployFailed();

        (bool ok, ) = proxy.call(initCode);
        if (!ok) revert InitCodeCallFailed();

        deployed = computeCreate3Address(salt, msg.sender);
        if (deployed.code.length == 0) revert NoCodeAtDeployedAddress();
    }

    /// @notice Predicts the address `deployCreate3(salt, _)` would deploy to,
    ///         given a hypothetical sender.
    function computeCreate3Address(bytes32 salt, address sender) public view returns (address) {
        bytes32 guardedSalt = keccak256(
            abi.encodePacked(bytes32(uint256(uint160(sender))), salt)
        );
        bytes32 proxyInitCodeHash = keccak256(hex"67363d3d37363d34f03d5260086018f3");
        address proxy = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), guardedSalt, proxyInitCodeHash)
                    )
                )
            )
        );
        // CREATE address from proxy with nonce 1: keccak256(rlp([proxy, 0x01]))
        // RLP: 0xd6 (list, 22 bytes) ++ 0x94 (string, 20 bytes) ++ proxy ++ 0x01
        return address(
            uint160(uint256(keccak256(abi.encodePacked(hex"d6_94", proxy, hex"01"))))
        );
    }
}
