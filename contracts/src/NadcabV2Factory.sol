// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {NadcabV2Pair} from "./NadcabV2Pair.sol";

/// @notice Creates pools and holds the DEX-wide fee settings, which the owner (feeToSetter) can change.
contract NadcabV2Factory {
    /// @dev 10% is the hard ceiling for the swap fee; the protocol can take at most half of it.
    uint256 public constant MAX_SWAP_FEE_BPS = 1_000;
    uint256 public constant MAX_PROTOCOL_SHARE_BPS = 5_000;

    address public feeTo;
    address public feeToSetter;
    uint256 public swapFeeBps;
    uint256 public protocolFeeShareBps;
    string public lpName;
    string public lpSymbol;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256);
    event SwapFeeChanged(uint256 swapFeeBps);
    event ProtocolFeeChanged(address feeTo, uint256 protocolFeeShareBps);
    event FeeToSetterChanged(address feeToSetter);

    constructor(
        address _feeToSetter,
        uint256 _swapFeeBps,
        address _feeTo,
        uint256 _protocolFeeShareBps,
        string memory _lpName,
        string memory _lpSymbol
    ) {
        require(_feeToSetter != address(0), "NadcabV2: ZERO_ADDRESS");
        require(_swapFeeBps > 0 && _swapFeeBps <= MAX_SWAP_FEE_BPS, "NadcabV2: SWAP_FEE");
        require(_protocolFeeShareBps <= MAX_PROTOCOL_SHARE_BPS, "NadcabV2: PROTOCOL_SHARE");
        require(bytes(_lpName).length > 0 && bytes(_lpSymbol).length > 0, "NadcabV2: LP_NAME");
        feeToSetter = _feeToSetter;
        swapFeeBps = _swapFeeBps;
        feeTo = _feeTo;
        protocolFeeShareBps = _protocolFeeShareBps;
        lpName = _lpName;
        lpSymbol = _lpSymbol;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @notice keccak256 of the pair creation code, for computing pair addresses off-chain.
    function pairCodeHash() external pure returns (bytes32) {
        return keccak256(type(NadcabV2Pair).creationCode);
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "NadcabV2: IDENTICAL_ADDRESSES");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "NadcabV2: ZERO_ADDRESS");
        require(getPair[token0][token1] == address(0), "NadcabV2: PAIR_EXISTS");
        pair = address(new NadcabV2Pair{salt: keccak256(abi.encodePacked(token0, token1))}());
        NadcabV2Pair(pair).initialize(token0, token1);
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    modifier onlySetter() {
        require(msg.sender == feeToSetter, "NadcabV2: FORBIDDEN");
        _;
    }

    function setSwapFee(uint256 _swapFeeBps) external onlySetter {
        require(_swapFeeBps > 0 && _swapFeeBps <= MAX_SWAP_FEE_BPS, "NadcabV2: SWAP_FEE");
        swapFeeBps = _swapFeeBps;
        emit SwapFeeChanged(_swapFeeBps);
    }

    function setFeeTo(address _feeTo) external onlySetter {
        feeTo = _feeTo;
        emit ProtocolFeeChanged(_feeTo, protocolFeeShareBps);
    }

    function setProtocolFeeShare(uint256 _protocolFeeShareBps) external onlySetter {
        require(_protocolFeeShareBps <= MAX_PROTOCOL_SHARE_BPS, "NadcabV2: PROTOCOL_SHARE");
        protocolFeeShareBps = _protocolFeeShareBps;
        emit ProtocolFeeChanged(feeTo, _protocolFeeShareBps);
    }

    function setFeeToSetter(address _feeToSetter) external onlySetter {
        require(_feeToSetter != address(0), "NadcabV2: ZERO_ADDRESS");
        feeToSetter = _feeToSetter;
        emit FeeToSetterChanged(_feeToSetter);
    }
}
