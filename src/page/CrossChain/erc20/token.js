import axios from "axios";
import { from, Subject } from "rxjs";
import { delay, map, retryWhen, switchMap } from "rxjs/operators";
import Web3 from "web3";
import transferBridgeABI from "../abi/Backing.json";
import Erc20StringABI from "../abi/Erc20-string.json";
import mappingTokenABI from "../abi/MappingToken.json";
import configJson from "../config.json";
import {
    getMetamaskActiveAccount,
    getMPTProof,
    isNetworkMatch,
} from "../utils";
import {
    getNameAndLogo,
    getSymbolAndDecimals,
    getTokenBalance,
    tokenInfoGetter,
} from "./token-util";

const config = configJson[process.env.REACT_APP_CHAIN];
const { backingContract, mappingContract, web3 } = (() => {
    const web3 = new Web3(window.ethereum || window.web3.currentProvider);
    const backingContract = new web3.eth.Contract(
        transferBridgeABI,
        config.TRANSFER_BRIDGE_ETH_ADDRESS
    );
    const web3Darwinia = new Web3(config.DARWINIA_PROVIDER);
    const mappingContract = new web3Darwinia.eth.Contract(
        mappingTokenABI,
        config.MAPPING_FACTORY_ADDRESS
    );

    return {
        backingContract,
        mappingContract,
        web3,
    };
})();

const proofSubject = new Subject();

/**
 * proof events stream
 */
export const proofObservable = proofSubject.asObservable();

const getTokenInfo = async (tokenAddress, currentAccount) => {
    const { symbol = "", decimals = 0 } = await tokenInfoGetter(tokenAddress);
    const { name, logo } = getNameAndLogo(tokenAddress);

    let balance = Web3.utils.toBN(0);

    if (currentAccount) {
        balance = await getTokenBalance(tokenAddress, currentAccount);
    }

    return {
        address: tokenAddress,
        symbol,
        decimals,
        name,
        logo,
        balance,
    };
};

export const getAllTokens = async (currentAccount, networkType = "eth") => {
    if (!currentAccount) {
        return [];
    }

    return networkType === "eth"
        ? await getAllTokensEthereum(currentAccount)
        : await getAllTokensDvm(currentAccount);
};

const getAllTokensDvm = async (currentAccount) => {
    const length = await mappingContract.methods.tokenLength().call(); // length: string
    const tokens = await Promise.all(
        new Array(+length).fill(0).map(async (_, index) => {
            const address = await mappingContract.methods
                .allTokens(index)
                .call(); // dvm address
            const info = await mappingContract.methods
                .tokenToInfo(address)
                .call(); // { source, backing }
            const token = await getTokenInfo(info.source, currentAccount);

            return { ...info, ...token };
        })
    );

    return tokens;
};

const getAllTokensEthereum = async (currentAccount) => {
    const length = await backingContract.methods.assetLength().call();
    const tokens = await Promise.all(
        new Array(+length).fill(0).map(async (_, index) => {
            const address = await backingContract.methods
                .allAssets(index)
                .call();

            return await getTokenInfo(address, currentAccount);
        })
    );

    return tokens;
};

/**
 * test address 0x1F4E71cA23f2390669207a06dDDef70BDE75b679;
 * @param { Address } address - erc20 token address
 * @return { Promise<void | subscription> } - void
 */
export const registerToken = async (address) => {
    const isRegistered = await hasRegistered(address);

    if (!isRegistered) {
        const from = await getMetamaskActiveAccount();
        const { isString } = await getSymbolType(address);
        const register = isString
            ? backingContract.methods.registerToken
            : backingContract.methods.registerTokenBytes32;
        const txHash = await register(address).send({ from });

        console.log(
            "%c [ register token transaction hash ]-118",
            "font-size:13px; background:pink; color:#bf2c9f;",
            txHash
        );

        return monitorEventProof(address);
    }
};

/**
 * @function getSymbolType - Predicate the return type of the symbol method in erc20 token abi;
 * @param {string} - address
 * @returns {Promise<{symbol: string; isString: boolean }>}
 */
export const getSymbolType = async (address) => {
    try {
        const stringContract = new web3.eth.Contract(Erc20StringABI, address);
        const symbol = await stringContract.methods.symbol().call();

        return { symbol, isString: true };
    } catch (error) {
        const { symbol } = await getSymbolAndDecimals(address);

        return { symbol, isString: false };
    }
};

/**
 *
 * @param {Address} address - token address
 * @returns subscription
 */
const monitorEventProof = (address) => {
    // api response: {
    //  "extrinsic_index": string; "account_id": string; "block_num": number; "block_hash": string; "backing": string; "source": string; "target": string; "block_timestamp": number;
    //  "mmr_index": number; "mmr_root": string; "signatures": string; "block_header": JSON string; "tx": string;
    // }
    const api = axios
        .get(`${config.DAPP_API}/api/ethereumIssuing/register`, {
            params: { source: address },
        })
        .then((res) => res.data);
    const proofAddress =
        "0xe66f3de22eed97c730152f373193b5a0485b407d88f37d5fd6a2c59e5a696691";

    return from(api)
        .pipe(
            map((data) => {
                if (!data) {
                    throw new Error("Unreceived register block info");
                }

                return data;
            }),
            retryWhen((error) => error.pipe(delay(3000))),
            switchMap(({ block_hash }) =>
                from(getMPTProof(block_hash, proofAddress))
            )
        )
        .subscribe(proofSubject);
};

/**
 *
 * @param {Address} address - erc20 token address
 * @return {Promise<number>} status - 0: unregister 1: registered 2: registering
 */
export const getTokenRegisterStatus = async (address) => {
    if (!address || !Web3.utils.isAddress(address)) {
        console.warn(
            `Token address is invalid, except an ERC20 token address. Received value: ${address}`
        );
        return;
    }

    const { target, timestamp } = await backingContract.methods
        .assets(address)
        .call();
    const isTargetTruthy = !!Web3.utils.hexToNumber(target);
    const isTimestampExist = +timestamp > 0;

    if (isTimestampExist && !isTargetTruthy) {
        return 2;
    }

    if (isTimestampExist && isTargetTruthy) {
        return 1;
    }

    return 0;
};

export const hasRegistered = async (address) => {
    const status = await getTokenRegisterStatus(address);

    return !!status;
};

export const confirmRegister = async (proof) => {
    const result = await backingContract.methods.crossChainSync(proof);

    return result;
};

export async function crossSendErc20FromEthToDvm(
    tokenAddress,
    recipientAddress,
    amount
) {
    const result = await backingContract.methods.crossSendToken(
        tokenAddress,
        recipientAddress,
        amount.toString()
    );

    return result;
}

export async function crossSendErc20FromDvmToEth(
    tokenAddress,
    recipientAddress,
    amount
) {
    // dev env pangolin(id: 43) product env darwinia(id: ?);
    const isMatch = await isNetworkMatch(config.DVM_NETWORK_ID);

    if (isMatch) {
        const result = await mappingContract.methods.crossTransfer(
            tokenAddress,
            recipientAddress,
            amount.toString()
        );

        return result;
    } else {
        throw new Error(
            "common:Ethereum network type does not match, please switch to {{network}} network in metamask."
        );
    }
}
