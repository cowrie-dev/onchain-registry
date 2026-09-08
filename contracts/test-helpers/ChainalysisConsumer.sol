// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
interface IChainalysisSanctionsList {
    function isSanctioned(address account) external view returns (bool);
}
contract ChainalysisConsumer {
    function check(address oracle, address account) external view returns (bool) {
        return IChainalysisSanctionsList(oracle).isSanctioned(account);
    }
}
