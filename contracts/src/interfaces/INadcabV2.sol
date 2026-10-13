// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

interface IERC20Minimal {
    function balanceOf(address owner) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
}

interface IWrappedNative {
    function deposit() external payable;
    function transfer(address to, uint256 value) external returns (bool);
    function withdraw(uint256) external;
}

interface INadcabV2Callee {
    function nadcabV2Call(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external;
}

interface INadcabV2Factory {
    function feeTo() external view returns (address);
    function swapFeeBps() external view returns (uint256);
    function protocolFeeShareBps() external view returns (uint256);
    function lpName() external view returns (string memory);
    function lpSymbol() external view returns (string memory);
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface INadcabV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function mint(address to) external returns (uint256 liquidity);
    function burn(address to) external returns (uint256 amount0, uint256 amount1);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}
