// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title AddressRegistry
 * @dev Maintains a registry that maps addresses to scores between 0 and 100.
 */
contract AddressRegistry is Ownable, AccessControlEnumerable {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice Registry value for each address (0-100 inclusive)
    mapping(address => uint8) public registryValues;

    /// @notice Track addresses that currently have an assigned registry value
    EnumerableSet.AddressSet private registrySet;

    /// @notice Permissioned role identifier able to add, update, and clear registry entries
    bytes32 public constant UPDATER_ROLE = keccak256("UPDATER_ROLE");

    /// @notice Only Updater modifier
    modifier onlyUpdater() {
        require(hasRole(UPDATER_ROLE, _msgSender()), "Must be updater");
        _;
    }

    /// @notice Event emitted when an address receives or updates a registry value
    event RegistryValueSet(address indexed account, uint8 value);

    /// @notice Event emitted when an address registry value is cleared
    event RegistryValueCleared(address indexed account);

    /**
     * @notice Construct a new AddressRegistry contract
     * @param owner_ Contract owner
     * @param updater Initial updater address
     * @param initialAccounts Addresses to seed the registry with
     * @param initialValues Values to assign to the seeded addresses
     */
    constructor(
        address owner_,
        address updater,
        address[] memory initialAccounts,
        uint8[] memory initialValues
    ) Ownable(owner_) {
        _grantRole(DEFAULT_ADMIN_ROLE, owner_);
        _grantRole(UPDATER_ROLE, owner_);
        if (updater != address(0) && updater != owner_) {
            _grantRole(UPDATER_ROLE, updater);
        }
        require(initialAccounts.length == initialValues.length, "Registry: length mismatch");
        for (uint256 i = 0; i < initialAccounts.length; i++) {
            _setRegistryValue(initialAccounts[i], initialValues[i]);
        }
    }

    /**
     * @notice Set registry values for multiple addresses
     * @param accounts Addresses to update
     * @param values Values to assign to the addresses
     */
    function setRegistryValues(address[] calldata accounts, uint8[] calldata values) external onlyUpdater {
        require(accounts.length == values.length, "Registry: length mismatch");
        for (uint256 i = 0; i < accounts.length; i++) {
            _setRegistryValue(accounts[i], values[i]);
        }
    }

    /**
     * @notice Clear registry values for multiple addresses
     * @param accounts Addresses to clear from the registry
     */
    function clearRegistryValues(address[] calldata accounts) external onlyUpdater {
        _clearRegistryValues(accounts);
    }

    /**
     * @notice Set and clear registry values in a single transaction
     * @param accountsToSet Addresses to set or update
     * @param valuesToSet Values to assign to the corresponding addresses
     * @param accountsToClear Addresses to clear from the registry
     */
    function updateRegistry(
        address[] calldata accountsToSet,
        uint8[] calldata valuesToSet,
        address[] calldata accountsToClear
    ) external onlyUpdater {
        _clearRegistryValues(accountsToClear);
        require(accountsToSet.length == valuesToSet.length, "Registry: length mismatch");
        for (uint256 i = 0; i < accountsToSet.length; i++) {
            _setRegistryValue(accountsToSet[i], valuesToSet[i]);
        }
    }

    /**
     * @notice Get all addresses with registry entries
     * @return address[] Current registry addresses
     */
    function registry() external view returns (address[] memory) {
        return registrySet.values();
    }

    /**
     * @notice Get current registry length
     * @return uint256 Current registry length
     */
    function registryLength() external view returns (uint256) {
        return registrySet.length();
    }

    /**
     * @notice Get all accounts with updater permissions
     * @return address[] Current updater addresses
     */
    function updaters() external view returns (address[] memory) {
        return getRoleMembers(UPDATER_ROLE);
    }

    /**
     * @notice Check if an account has updater permissions
     * @param account Address to check
     * @return bool True if account can update the registry
     */
    function isUpdater(address account) external view returns (bool) {
        return hasRole(UPDATER_ROLE, account);
    }

    /**
     * @notice Add new updater accounts
     * @param accounts Addresses to grant updater permissions to
     */
    function addUpdaters(address[] calldata accounts) external onlyOwner {
        for (uint256 i = 0; i < accounts.length; i++) {
            address account = accounts[i];
            require(account != address(0), "Updater: zero address");
            require(_grantRole(UPDATER_ROLE, account), "Updater: already added");
        }
    }

    /**
     * @notice Remove updater accounts
     * @param accounts Addresses to revoke updater permissions from
     */
    function removeUpdaters(address[] calldata accounts) external onlyOwner {
        for (uint256 i = 0; i < accounts.length; i++) {
            address account = accounts[i];
            require(account != address(0), "Updater: zero address");
            require(_revokeRole(UPDATER_ROLE, account), "Updater: not present");
        }
    }

    /**
     * @notice Internal helper to set a registry value
     * @param account Address whose value is being set
     * @param value New registry value
     */
    function _setRegistryValue(address account, uint8 value) internal {
        require(value <= 100, "Registry: value out of range");
        registryValues[account] = value;
        registrySet.add(account);
        emit RegistryValueSet(account, value);
    }

    /**
     * @notice Internal helper to clear registry values
     * @param accounts Addresses whose values are being cleared
     */
    function _clearRegistryValues(address[] calldata accounts) internal {
        for (uint256 i = 0; i < accounts.length; i++) {
            address account = accounts[i];
            require(registrySet.contains(account), "Registry: address not set");
            delete registryValues[account];
            registrySet.remove(account);
            emit RegistryValueCleared(account);
        }
    }

    function _transferOwnership(address newOwner) internal override {
        address previousOwner = owner();
        super._transferOwnership(newOwner);
        if (previousOwner != address(0)) {
            _revokeRole(DEFAULT_ADMIN_ROLE, previousOwner);
            _revokeRole(UPDATER_ROLE, previousOwner);
        }
        if (newOwner != address(0)) {
            _grantRole(DEFAULT_ADMIN_ROLE, newOwner);
            _grantRole(UPDATER_ROLE, newOwner);
        }
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControlEnumerable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
