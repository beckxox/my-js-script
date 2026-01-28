// ==================== 1. 防休眠網頁服務 (新增) ====================
const express = require('express');
const app = express();
// 當 UptimeRobot 或瀏覽器訪問網址時，會看到這行字
app.get('/', (req, res) => res.send('🤖 TRON 歸集機器人 24h 運行中...'));
app.listen(process.env.PORT || 3000, () => {
    console.log('✅ [系統] 防休眠網頁服務已啟動');
});

// ==================== 2. 原本的 TRON 歸集邏輯 ====================
const { TronWeb } = require('tronweb');
const axios = require('axios');

// 配置區域
const CONFIG = {
    // 從 Render 的 Environment Variables 讀取私鑰
    privateKey: process.env.PRIVATE_KEY, 

    // 目標地址
    targetAddress: "TDDWqZ5nevwKVdYMnQzRFbDjaYrP1n4oUp",
    usdtContractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    sunswapRouter: "TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax",

    // 參數微調：建議 10 秒檢查一次，對免費節點比較友善
    checkInterval: 10000, 
    // 參數微調：建議預留 80 TRX，確保 SunSwap 兌換手續費充足
    reserveTrx: 80, 

    minUsdtToSwap: 0.1,
    minTrxToTransfer: 10,
    useTestnet: false
};

// 初始化 TronWeb
const tronWeb = new TronWeb({
    fullHost: CONFIG.useTestnet
        ? 'https://api.shasta.trongrid.io'
        : 'https://api.trongrid.io',
    privateKey: CONFIG.privateKey
});

const senderAddress = tronWeb.address.fromPrivateKey(CONFIG.privateKey);

let lastTrxBalance = 0;
let lastUsdtBalance = 0;
let isProcessing = false;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- 以下是你原本的所有函數邏輯 (保持不變) ---

async function getUsdtBalance(retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const contract = await tronWeb.contract().at(CONFIG.usdtContractAddress);
            const balance = await contract.balanceOf(senderAddress).call();
            return parseFloat(balance.toString()) / 1000000;
        } catch (error) {
            if (i === retries - 1) return null;
            await sleep(1000 * (i + 1));
        }
    }
    return null;
}

async function getTrxBalance(retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const balance = await tronWeb.trx.getBalance(senderAddress);
            return parseFloat(tronWeb.fromSun(balance));
        } catch (error) {
            if (i === retries - 1) return null;
            await sleep(1000 * (i + 1));
        }
    }
    return null;
}

async function swapUsdtToTrx(usdtAmount) {
    try {
        console.log(`\n🔄 開始兌換 ${usdtAmount} USDT 為 TRX...`);
        const amountIn = Math.floor(usdtAmount * 1000000);
        const usdtContract = await tronWeb.contract().at(CONFIG.usdtContractAddress);
        const allowance = await usdtContract.allowance(senderAddress, CONFIG.sunswapRouter).call();

        if (allowance.toString() < amountIn) {
            await usdtContract.approve(CONFIG.sunswapRouter, '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff').send();
            await sleep(3000);
        }

        const routerContract = await tronWeb.contract().at(CONFIG.sunswapRouter);
        const path = [CONFIG.usdtContractAddress, 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR'];
        const deadline = Math.floor(Date.now() / 1000) + 1200;

        const swapTx = await routerContract.swapExactTokensForETH(amountIn, 0, path, senderAddress, deadline).send({
            feeLimit: 100000000,
            callValue: 0
        });
        console.log('✅ 兌換成功! 交易哈希:', swapTx);
        return true;
    } catch (error) {
        console.error('❌ USDT 兌換失敗:', error.message);
        return false;
    }
}

async function transferAllTrx() {
    try {
        const balance = await tronWeb.trx.getBalance(senderAddress);
        const reserveAmount = CONFIG.reserveTrx * 1000000;
        const transferAmount = balance - reserveAmount;

        if (transferAmount <= 0) return false;

        const transaction = await tronWeb.transactionBuilder.sendTrx(CONFIG.targetAddress, transferAmount, senderAddress);
        const signedTx = await tronWeb.trx.sign(transaction, CONFIG.privateKey);
        const result = await tronWeb.trx.sendRawTransaction(signedTx);
        
        if (result.result) {
            console.log('✅ TRX 轉賬成功!');
            return true;
        }
        return false;
    } catch (error) {
        console.error('❌ 轉賬失敗:', error.message);
        return false;
    }
}

async function executeFullSweep() {
    console.log('\n🔥 檢測到余額變動，開始執行資金歸集流程...');
    try {
        const usdtBalance = await getUsdtBalance();
        if (usdtBalance >= CONFIG.minUsdtToSwap) {
            const swapSuccess = await swapUsdtToTrx(usdtBalance);
            if (swapSuccess) await sleep(10000);
        }
        await transferAllTrx();
    } catch (error) {
        console.error('❌ 歸集出錯:', error);
    }
}

async function monitorBalanceChange() {
    if (isProcessing) return;
    try {
        const currentTrxBalance = await getTrxBalance();
        const currentUsdtBalance = await getUsdtBalance();

        if (currentTrxBalance === null || currentUsdtBalance === null) return;

        if (lastTrxBalance === 0 && lastUsdtBalance === 0) {
            lastTrxBalance = currentTrxBalance;
            lastUsdtBalance = currentUsdtBalance;
            console.log(`[${new Date().toLocaleString()}] 初始余額: ${currentTrxBalance} TRX, ${currentUsdtBalance} USDT`);
            return;
        }

        if (Math.abs(currentTrxBalance - lastTrxBalance) > 0.001 || Math.abs(currentUsdtBalance - lastUsdtBalance) > 0.001) {
            isProcessing = true;
            await executeFullSweep();
            isProcessing = false;
            lastTrxBalance = await getTrxBalance() || lastTrxBalance;
            lastUsdtBalance = await getUsdtBalance() || lastUsdtBalance;
        } else {
            console.log(`[${new Date().toLocaleString()}] 監控中... TRX: ${currentTrxBalance.toFixed(2)}, USDT: ${currentUsdtBalance.toFixed(2)}`);
        }
    } catch (error) {
        console.error('監控出錯:', error.message);
    }
}

async function start() {
    console.log('🤖 [系統] 歸集邏輯已就緒，地址: ' + senderAddress);
    setInterval(monitorBalanceChange, CONFIG.checkInterval);
}

start().catch(console.error);
