import { ethers, providers } from "ethers";
import hre from "hardhat";
import * as dotenv from "dotenv";
import { IRebalancer } from "../../dist/contracts/typechain/IRebalancer";
import { IRebalancerFactory } from "../../dist/contracts/typechain/IRebalancerFactory";
import { IUniswapV3Pool } from "../../dist/contracts/typechain/IUniswapV3Pool";
import { Position } from "@uniswap/v3-sdk"

dotenv.config();

const getProvider = (): ethers.providers.Provider => {
    let provider: ethers.providers.Provider;
    if (process.env.PROVIDER === undefined) throw `PROVIDER is undefined`;

    if (process.env.PROVIDER_TYPE == "ipc") {
        provider = new ethers.providers.IpcProvider(process.env.PROVIDER);
    } else if (process.env.PROVIDER_TYPE == "http") {
        provider = new ethers.providers.JsonRpcProvider(process.env.PROVIDER);
    } else {
        throw `Unrecognized PROVIDER_TYPE == ${process.env.PROVIDER_TYPE}`;
    }
    return provider;
};

const getContracts = async (
    signer: ethers.Signer
): Promise<[ethers.Contract, ethers.Contract, ethers.Contract]> => {
    let rebalancerAddress: string;
    let hardhatRebalancerFactory;

    if (process.env.NODE_ENV == "development") {
        const RebalancerFactory = await hre.ethers.getContractFactory(
            "RebalancerFactory",
            signer
        );
        hardhatRebalancerFactory = await RebalancerFactory.deploy();
        let tx = await hardhatRebalancerFactory.createRebalancer(
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
            "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
            3000
        );
        tx = await tx.wait();
        rebalancerAddress = tx.events[0].args.rebalancer;
    } else {
        if (process.env.REBALANCER_ADDRESS === undefined)
            throw "In production contract should be deployed. You must set contract address";
        rebalancerAddress = process.env.REBALANCER_ADDRESS;
    }
    const rebalancer = await hre.ethers.getContractAt(
        "Rebalancer",
        rebalancerAddress
    );
    hardhatRebalancerFactory = await hre.ethers.getContractAt(
        "RebalancerFactory",
        await rebalancer.factory()
    );
    const pool = await hre.ethers.getContractAt(
        "UniswapV3Pool",
        await rebalancer.pool()
    );
    return [rebalancer, hardhatRebalancerFactory, pool];
};

async function* getLatestBlock(provider: ethers.providers.Provider) {
    let lastSeenBlockNumber = await provider.getBlockNumber();
    while (true) {
        const latestBlockNumber = await provider.getBlockNumber();
        if (latestBlockNumber > lastSeenBlockNumber) {
            lastSeenBlockNumber = latestBlockNumber;
            yield ethers.BigNumber.from(lastSeenBlockNumber);
        }
    }
}

const needToStartSummarization = async (
    rebalancer: IRebalancer,
    factory: IRebalancerFactory,
    lastBlock: ethers.BigNumber
): Promise<boolean> => {
    const summParams = await rebalancer.summParams();
    const frequency = await factory.summarizationFrequency();

    // (lastBlock - summParams.lastBlock) >= frequency
    return lastBlock.sub(summParams.lastBlock).gte(frequency);
};

const summarizationInProcess = async (
    rebalancer: IRebalancer
): Promise<boolean> => {
    const summParams = await rebalancer.summParams();
    return summParams.stage.gt(0);
};

const priceInPositionRange = (rebalancer: IRebalancer): boolean => {
    return true;
};
const calcRebalanceParams = (rebalancer: IRebalancer): number => {
    return 0;
};
const executeRebalancing = (rebalancer: IRebalancer): boolean => {
    return true;
};

const sendTransaction = async (
    func: Function,
    name: string
): Promise<boolean> => {
    try {
        const tx = await func();
        const receipt = await tx.wait();
        console.log(`Executed ${name}`);
        console.log(receipt);
        return true;
    } catch (e) {
        console.log(e);
        console.log(e.transactionHash);
        return false;
    }
};

const summarizeUsersStatesTillTheEnd = async (rebalancer: IRebalancer): Promise<boolean> => {
    let summParams = await rebalancer.summParams();
    do {
        await sendTransaction(
            rebalancer.summarizeUsersStates,
            "summarizeUsersStates"
        );

        summParams = await rebalancer.summParams();
        console.log(summParams.stage.toString());
    } while (!summParams.stage.eq(0));

    return true
};

const main = async () => {
    const provider = getProvider();
    const accounts = await hre.ethers.getSigners();
    const [rebalancer, factory] = (await getRebalancer(accounts[0])) as [
        IRebalancer,
        IUniswapV3Pool
    ];

    for await (const newBlockNumber of getLatestBlock(provider)) {
        console.log(newBlockNumber);
        if (
            needToStartSummarization(rebalancer, factory, newBlockNumber) ||
            summarizationInProcess(rebalancer)
        ) {
            let summParams = await rebalancer.summParams();
            if (summParams.stage.eq(0)) {
                let result = await sendTransaction(
                    rebalancer.startSummarizeTrades,
                    "startSummarizeTrades"
                );

                // If we get error, we shouldn't continue next stage
                if (!result) continue;
            }
            await summarizeUsersStatesTillTheEnd(rebalancer);
        }

        if (priceInPositionRange(rebalancer)) {
            continue;
        } else {
            const rebalanceParams = calcRebalanceParams(rebalancer);
            executeRebalancing(rebalancer);
        }
    }
};

main().then(() => {});
