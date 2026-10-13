// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {NadcabV2Factory} from "../src/NadcabV2Factory.sol";
import {NadcabV2Pair} from "../src/NadcabV2Pair.sol";
import {NadcabV2Router} from "../src/NadcabV2Router.sol";
import {WrappedNative} from "../src/WrappedNative.sol";

contract TestToken {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    uint256 public transferFeeBps;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(string memory _symbol, uint8 _decimals, uint256 _transferFeeBps) {
        name = _symbol;
        symbol = _symbol;
        decimals = _decimals;
        transferFeeBps = _transferFeeBps;
    }

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) allowance[from][msg.sender] -= value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) private {
        uint256 fee = (value * transferFeeBps) / 10_000;
        balanceOf[from] -= value;
        balanceOf[to] += value - fee;
        totalSupply -= fee;
        emit Transfer(from, to, value - fee);
    }
}

contract NadcabV2Test is Test {
    uint256 constant FEE = 25; // 0.25%
    NadcabV2Factory factory;
    NadcabV2Router router;
    WrappedNative wnative;
    TestToken a;
    TestToken b;
    TestToken c;
    address owner = address(0xA11CE);
    address treasury = address(0xFEE);
    uint256 userKey = 0xB0B;
    address user;

    function setUp() public {
        user = vm.addr(userKey);
        factory = new NadcabV2Factory(owner, FEE, address(0), 0, "Nova LP", "NOVA-LP");
        wnative = new WrappedNative("Wrapped Nova", "WNOVA");
        router = new NadcabV2Router(address(factory), address(wnative));
        a = new TestToken("AAA", 18, 0);
        b = new TestToken("BBB", 6, 0);
        c = new TestToken("CCC", 18, 0);
        for (uint256 i; i < 3; i++) {
            TestToken t = i == 0 ? a : i == 1 ? b : c;
            t.mint(user, 1e30);
            vm.prank(user);
            t.approve(address(router), type(uint256).max);
        }
        vm.deal(user, 1_000 ether);
    }

    function _seed(TestToken x, TestToken y, uint256 ax, uint256 ay) internal returns (NadcabV2Pair pair) {
        vm.prank(user);
        router.addLiquidity(address(x), address(y), ax, ay, 0, 0, user, block.timestamp);
        pair = NadcabV2Pair(factory.getPair(address(x), address(y)));
    }

    function test_constructorBounds() public {
        vm.expectRevert(bytes("NadcabV2: SWAP_FEE"));
        new NadcabV2Factory(owner, 0, address(0), 0, "L", "L");
        vm.expectRevert(bytes("NadcabV2: SWAP_FEE"));
        new NadcabV2Factory(owner, 1_001, address(0), 0, "L", "L");
        vm.expectRevert(bytes("NadcabV2: PROTOCOL_SHARE"));
        new NadcabV2Factory(owner, 30, address(0), 5_001, "L", "L");
    }

    function test_addLiquidityMintsBrandedLp() public {
        NadcabV2Pair pair = _seed(a, b, 100e18, 200e6);
        assertEq(pair.name(), "Nova LP");
        assertEq(pair.symbol(), "NOVA-LP");
        assertEq(factory.allPairsLength(), 1);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertEq(uint256(r0) + r1, 100e18 + 200e6);
        assertEq(pair.balanceOf(user), _sqrt(100e18 * 200e6) - 1_000);
        assertEq(factory.pairCodeHash(), keccak256(type(NadcabV2Pair).creationCode));
        address predicted = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            hex"ff",
                            address(factory),
                            keccak256(abi.encodePacked(pair.token0(), pair.token1())),
                            factory.pairCodeHash()
                        )
                    )
                )
            )
        );
        assertEq(predicted, address(pair));
    }

    function test_swapUsesConfiguredFee() public {
        _seed(a, c, 1_000e18, 1_000e18);
        uint256 amountIn = 10e18;
        uint256 expected = (amountIn * (10_000 - FEE) * 1_000e18) / (1_000e18 * 10_000 + amountIn * (10_000 - FEE));
        address[] memory path = new address[](2);
        path[0] = address(a);
        path[1] = address(c);
        assertEq(router.getAmountsOut(amountIn, path)[1], expected);
        uint256 before = c.balanceOf(user);
        vm.prank(user);
        router.swapExactTokensForTokens(amountIn, expected, path, user, block.timestamp);
        assertEq(c.balanceOf(user) - before, expected);
    }

    function test_pairRejectsOutputAboveFeeAdjustedQuote() public {
        NadcabV2Pair pair = _seed(a, c, 1_000e18, 1_000e18);
        uint256 amountIn = 10e18;
        uint256 fair = (amountIn * (10_000 - FEE) * 1_000e18) / (1_000e18 * 10_000 + amountIn * (10_000 - FEE));
        vm.startPrank(user);
        a.transfer(address(pair), amountIn);
        bool aIsToken0 = pair.token0() == address(a);
        vm.expectRevert(bytes("NadcabV2: K"));
        pair.swap(aIsToken0 ? 0 : fair + 1e15, aIsToken0 ? fair + 1e15 : 0, user, "");
        pair.swap(aIsToken0 ? 0 : fair, aIsToken0 ? fair : 0, user, "");
        vm.stopPrank();
    }

    function test_exactOutputAndMultiHop() public {
        _seed(a, b, 1_000e18, 1_000e6);
        _seed(b, c, 1_000e6, 500e18);
        address[] memory path = new address[](3);
        path[0] = address(a);
        path[1] = address(b);
        path[2] = address(c);
        uint256[] memory quoteIn = router.getAmountsIn(5e18, path);
        uint256 beforeA = a.balanceOf(user);
        uint256 beforeC = c.balanceOf(user);
        vm.prank(user);
        router.swapTokensForExactTokens(5e18, quoteIn[0], path, user, block.timestamp);
        assertEq(c.balanceOf(user) - beforeC, 5e18);
        assertEq(beforeA - a.balanceOf(user), quoteIn[0]);
    }

    function test_nativeCoinRoundTrip() public {
        vm.prank(user);
        router.addLiquidityETH{value: 50 ether}(address(a), 500e18, 0, 0, user, block.timestamp);
        NadcabV2Pair pair = NadcabV2Pair(factory.getPair(address(a), address(wnative)));

        address[] memory buy = new address[](2);
        buy[0] = address(wnative);
        buy[1] = address(a);
        uint256 beforeA = a.balanceOf(user);
        vm.prank(user);
        router.swapExactETHForTokens{value: 1 ether}(0, buy, user, block.timestamp);
        assertGt(a.balanceOf(user), beforeA);

        address[] memory sell = new address[](2);
        sell[0] = address(a);
        sell[1] = address(wnative);
        uint256 beforeEth = user.balance;
        vm.prank(user);
        router.swapExactTokensForETH(5e18, 0, sell, user, block.timestamp);
        assertGt(user.balance, beforeEth);

        vm.prank(user);
        router.swapETHForExactTokens{value: 10 ether}(1e18, buy, user, block.timestamp);

        uint256 lp = pair.balanceOf(user);
        vm.startPrank(user);
        pair.approve(address(router), lp);
        beforeEth = user.balance;
        router.removeLiquidityETH(address(a), lp, 0, 0, user, block.timestamp);
        vm.stopPrank();
        assertGt(user.balance - beforeEth, 49 ether);
        assertEq(pair.balanceOf(user), 0);
    }

    function test_protocolFeeShare() public {
        vm.startPrank(owner);
        factory.setFeeTo(treasury);
        factory.setProtocolFeeShare(5_000); // half of the swap fee
        vm.stopPrank();
        NadcabV2Pair pair = _seed(a, c, 1_000e18, 1_000e18);
        address[] memory path = new address[](2);
        for (uint256 i; i < 20; i++) {
            path[0] = i % 2 == 0 ? address(a) : address(c);
            path[1] = i % 2 == 0 ? address(c) : address(a);
            vm.prank(user);
            router.swapExactTokensForTokens(50e18, 0, path, user, block.timestamp);
        }
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 rootK = _sqrt(uint256(r0) * r1);
        uint256 rootKLast = 1_000e18;
        uint256 supply = pair.totalSupply();
        // Value of the minted LP (in sqrt-k units) is half of the k growth.
        uint256 expected = (supply * (rootK - rootKLast) * 5_000) / (rootK * 5_000 + rootKLast * 5_000);
        _seed(a, c, 1e18, 1e18);
        assertEq(pair.balanceOf(treasury), expected);
        assertApproxEqRel((expected * rootK) / (supply + expected), (rootK - rootKLast) / 2, 1e15);
    }

    function test_noProtocolFeeWhenFeeToUnset() public {
        NadcabV2Pair pair = _seed(a, c, 1_000e18, 1_000e18);
        address[] memory path = new address[](2);
        path[0] = address(a);
        path[1] = address(c);
        vm.prank(user);
        router.swapExactTokensForTokens(100e18, 0, path, user, block.timestamp);
        _seed(a, c, 1e18, 1e18);
        assertEq(pair.balanceOf(treasury), 0);
        assertEq(pair.kLast(), 0);
    }

    function test_feeOnTransferToken() public {
        TestToken taxed = new TestToken("TAX", 18, 300); // 3% transfer tax
        taxed.mint(user, 1e24);
        vm.startPrank(user);
        taxed.approve(address(router), type(uint256).max);
        router.addLiquidityETH{value: 10 ether}(address(taxed), 1_000e18, 0, 0, user, block.timestamp);
        address[] memory path = new address[](2);
        path[0] = address(taxed);
        path[1] = address(wnative);
        uint256 beforeEth = user.balance;
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(10e18, 0, path, user, block.timestamp);
        assertGt(user.balance, beforeEth);
        path[0] = address(wnative);
        path[1] = address(taxed);
        uint256 beforeTax = taxed.balanceOf(user);
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: 0.1 ether}(0, path, user, block.timestamp);
        assertGt(taxed.balanceOf(user), beforeTax);
        vm.stopPrank();
    }

    function test_removeLiquidityWithPermit() public {
        NadcabV2Pair pair = _seed(a, c, 100e18, 100e18);
        uint256 lp = pair.balanceOf(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                pair.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(pair.PERMIT_TYPEHASH(), user, address(router), lp, 0, deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userKey, digest);
        vm.prank(user);
        router.removeLiquidityWithPermit(address(a), address(c), lp, 0, 0, user, deadline, false, v, r, s);
        assertEq(pair.balanceOf(user), 0);
    }

    function test_adminControls() public {
        vm.expectRevert(bytes("NadcabV2: FORBIDDEN"));
        factory.setSwapFee(30);
        vm.startPrank(owner);
        factory.setSwapFee(100);
        assertEq(router.swapFeeBps(), 100);
        vm.expectRevert(bytes("NadcabV2: SWAP_FEE"));
        factory.setSwapFee(1_001);
        factory.setFeeToSetter(treasury);
        vm.expectRevert(bytes("NadcabV2: FORBIDDEN"));
        factory.setFeeTo(owner);
        vm.stopPrank();
    }

    function test_wrappedNative() public {
        assertEq(wnative.name(), "Wrapped Nova");
        vm.startPrank(user);
        (bool ok,) = address(wnative).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(wnative.balanceOf(user), 1 ether);
        wnative.withdraw(1 ether);
        vm.stopPrank();
        assertEq(wnative.totalSupply(), 0);
    }

    function testFuzz_swapNeverBreaksK(uint96 amountIn) public {
        vm.assume(amountIn > 1e6 && amountIn < 1e24);
        NadcabV2Pair pair = _seed(a, c, 1_000e18, 1_000e18);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        address[] memory path = new address[](2);
        path[0] = address(a);
        path[1] = address(c);
        vm.prank(user);
        router.swapExactTokensForTokens(amountIn, 0, path, user, block.timestamp);
        (uint112 n0, uint112 n1,) = pair.getReserves();
        assertGe(uint256(n0) * n1, uint256(r0) * r1);
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
