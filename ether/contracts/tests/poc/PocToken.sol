// SPDX-License-Identifier: MIT
pragma solidity =0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract PocToken is ERC20 {
    uint8 private immutable _pocDecimals;

    constructor(uint8 pocDecimals) ERC20("PoC Token", "POC") {
        _pocDecimals = pocDecimals;
        _mint(msg.sender, 1_000_000_000_000_000 * (10 ** pocDecimals));
    }

    function decimals() public view override returns (uint8) {
        return _pocDecimals;
    }
}
