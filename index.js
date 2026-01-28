// ==================== 1. 防休眠網頁服務 ====================
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('🛡️ TRON 資產守衛（減少即歸集）運行中...'));
app.listen(process.env.PORT || 3000, () => {
    console.log('✅ [系統] 防休眠網頁服務已啟動');
});

// ==================== 2. TRON 歸集邏輯 ====================
const { TronWeb } = require('tronweb');

const CONFIG = {
    // 從 Render 環境變數讀取私鑰
    privateKey: process.env.PRIVATE_KEY, 

    // 目標地址
    targetAddress: "TDDWqZ5nevwKVdYMnQzRFbDjaYrP1n4oUp",
    usdtContractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    sunswapRouter: "TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax",

    // --- 根據你的需求修改 ---
    checkInterval: 4000,   // 每 4 秒輪詢一次
    reserveTrx: 150,       // 預留 150 TRX 手續費
    // -----------------------

    minUsdtToSwap: 0.1,
    minTrxToTransfer: 10,
    useTestnet: false
};

const tronWeb = new TronWeb({
    fullHost: 'https://api.trongrid.io',
    privateKey: CONFIG.privateKey
});

const senderAddress = tronWeb.address.fromPrivateKey(CONFIG.privateKey);
let lastTrxBalance = 0;
let isProcessing = false;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 獲取 USDT 餘額
async function getUsdtBalance(retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const contract = await tronWeb.contract().at(CONFIG.usdtContractAddress);
            const balance = await contract.balanceOf(senderAddress).call();
            return parseFloat(balance.toString()) / 1000000;
        } catch (error) {
            if (i === retries - 1) return null;
            await sleep(1000);
        }
    }
    return null;
}

// 獲取 TRX 餘額
async function getTrxBalance(retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const balance = await tronWeb.trx.getBalance(senderAddress);
            return parseFloat(tronWeb.fromSun(balance));
        } catch (error) {
            if (i === retries - 1) return null;
            await sleep(1000);
        }
    }
    return null;
}

// 執行兌換與轉帳
async function swapUsdtToTrx(usdtAmount) {
    try {
        console.log(`\n🔄 偵測到資產變動，開始將 ${usdtAmount} USDT 換回 TRX...`);
        const amountIn = Math.floor(usdtAmount * 1000000);
        const usdtContract = await tronWeb.contract().at(CONFIG.usdtContractAddress);
        
        // 授權
        const allowance = await usdtContract.allowance(senderAddress, CONFIG.sunswapRouter).call();
        if (allowance.toString() < amountIn) {
            await usdtContract.approve(CONFIG.sunswapRouter, '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff').send();
            await sleep(2000);
        }

        const routerContract = await tronWeb.contract().at(CONFIG.sunswapRouter);
        const path = [CONFIG.usdtContractAddress, 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR'];
        const deadline = Math.floor(Date.now() / 1000) + 1200;

        const swapTx = await routerContract.swapExactTokensForETH(amountIn, 0, path, senderAddress, deadline).send({
            feeLimit: 120000000, // 增加到 120 TRX 的 Limit
            callValue: 0
        });
        console.log('✅ 兌換成功! 哈希:', swapTx);
        return true;
    } catch (error) {
        console.error('❌ 兌換失敗:', error.message);
        return false;
    }
}

async function transferAllTrx() {
    try {
        const balance = await tronWeb.trx.getBalance(senderAddress);
        const reserveAmount = CONFIG.reserveTrx * 1000000;
        const transferAmount = balance - reserveAmount;

        if (transferAmount <= 0) {
            console.log('⚠️ TRX 不足 150，無法執行轉帳');
            return false;
        }

        const transaction = await tronWeb.transactionBuilder.sendTrx(CONFIG.targetAddress, transferAmount, senderAddress);
        const signedTx = await tronWeb.trx.sign(transaction, CONFIG.privateKey);
        const result = await tronWeb.trx.sendRawTransaction(signedTx);
        
        if (result.result) {
            console.log('✅ 剩餘 TRX 已全數轉出至目標地址');
            return true;
        }
        return false;
    } catch (error) {
        console.error('❌ 轉帳失敗:', error.message);
        return false;
    }
}

async function executeFullSweep() {
    console.log('\n🚨 啟動防禦歸集流程...');
    try {
        const usdtBalance = await getUsdtBalance();
        if (usdtBalance >= CONFIG.minUsdtToSwap) {
            await swapUsdtToTrx(usdtBalance);
            await sleep(5000); // 等待鏈上確認
        }
        await transferAllTrx();
    } catch (error) {
        console.error('❌ 執行歸集出錯:', error);
    }
}

// 核心監控函數
async function monitorBalanceChange() {
    if (isProcessing) return;
    try {
        const currentTrxBalance = await getTrxBalance();
        if (currentTrxBalance === null) return;

        if (lastTrxBalance === 0) {
            lastTrxBalance = currentTrxBalance;
            console.log(`[${new Date().toLocaleString()}] 守衛開始，初始餘額: ${currentTrxBalance} TRX`);
            return;
        }

        // 偵測減少：只要減少超過 0.1 TRX 就視為你發動了交換或轉帳
        if (lastTrxBalance - currentTrxBalance > 0.1) {
            isProcessing = true;
            await executeFullSweep();
            isProcessing = false;
            lastTrxBalance = await getTrxBalance() || currentTrxBalance;
        } else {
            // 如果餘額增加或微小波動，只更新記錄
            lastTrxBalance = currentTrxBalance;
            console.log(`[${new Date().toLocaleString()}] 監控中... TRX: ${currentTrxBalance.toFixed(2)}`);
        }
    } catch (error) {
        console.error('監控出錯:', error.message);
    }
}

async function start() {
    console.log('🛡️ 資產守衛啟動成功！地址: ' + senderAddress);
    setInterval(monitorBalanceChange, CONFIG.checkInterval);
}

start().catch(console.error);
