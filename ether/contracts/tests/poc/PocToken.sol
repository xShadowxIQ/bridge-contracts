// SPDX-License-Identifier: MIT
pragma solidity =0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract PocToken is ERC20 {
    constructor() ERC20("PoC Token", "POC") {
        _mint(msg.sender, 1_000_000 ether);
    }
}
