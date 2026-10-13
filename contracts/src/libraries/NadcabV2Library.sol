// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {INadcabV2Factory, INadcabV2Pair} from "../interfaces/INadcabV2.sol";

library NadcabV2Library {
    uint256 private constant BPS = 10_000;

    function sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        require(tokenA != tokenB, "NadcabV2Library: IDENTICAL_ADDRESSES");
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "NadcabV2Library: ZERO_ADDRESS");
    }

    function pairFor(address factory, address tokenA, address tokenB) internal view returns (address pair) {
        pair = INadcabV2Factory(factory).getPair(tokenA, tokenB);
        require(pair != address(0), "NadcabV2Library: PAIR_NOT_FOUND");
    }

    function getReserves(address factory, address tokenA, address tokenB)
        internal
        view
        returns (uint256 reserveA, uint256 reserveB)
    {
        (address token0,) = sortTokens(tokenA, tokenB);
        (uint256 reserve0, uint256 reserve1,) = INadcabV2Pair(pairFor(factory, tokenA, tokenB)).getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) internal pure returns (uint256 amountB) {
        require(amountA > 0, "NadcabV2Library: INSUFFICIENT_AMOUNT");
        require(reserveA > 0 && reserveB > 0, "NadcabV2Library: INSUFFICIENT_LIQUIDITY");
        amountB = (amountA * reserveB) / reserveA;
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        internal
        pure
        returns (uint256 amountOut)
    {
        require(amountIn > 0, "NadcabV2Library: INSUFFICIENT_INPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "NadcabV2Library: INSUFFICIENT_LIQUIDITY");
        uint256 amountInWithFee = amountIn * (BPS - feeBps);
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * BPS + amountInWithFee);
    }

    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        internal
        pure
        returns (uint256 amountIn)
    {
        require(amountOut > 0, "NadcabV2Library: INSUFFICIENT_OUTPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "NadcabV2Library: INSUFFICIENT_LIQUIDITY");
        amountIn = (reserveIn * amountOut * BPS) / ((reserveOut - amountOut) * (BPS - feeBps)) + 1;
    }

    function getAmountsOut(address factory, uint256 amountIn, address[] memory path)
        internal
        view
        returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "NadcabV2Library: INVALID_PATH");
        uint256 feeBps = INadcabV2Factory(factory).swapFeeBps();
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i; i < path.length - 1; i++) {
            (uint256 reserveIn, uint256 reserveOut) = getReserves(factory, path[i], path[i + 1]);
            amounts[i + 1] = getAmountOut(amounts[i], reserveIn, reserveOut, feeBps);
        }
    }

    function getAmountsIn(address factory, uint256 amountOut, address[] memory path)
        internal
        view
        returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "NadcabV2Library: INVALID_PATH");
        uint256 feeBps = INadcabV2Factory(factory).swapFeeBps();
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint256 i = path.length - 1; i > 0; i--) {
            (uint256 reserveIn, uint256 reserveOut) = getReserves(factory, path[i - 1], path[i]);
            amounts[i - 1] = getAmountIn(amounts[i], reserveIn, reserveOut, feeBps);
        }
    }
}
