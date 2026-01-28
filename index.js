// TronWeb 余額變動自動歸集腳本
// 功能：監控錢包余額變化，當檢測到余額增加時，自動將所有 USDT 兌換成 TRX 並歸集
const { TronWeb } = require('tronweb');
const axios = require('axios');

// ==================== 配置區域 ====================
const CONFIG = {
    // 私鑰
    privateKey: process.env.PRIVATE_KEY || "YOUR_PRIVATE_KEY_HERE",

    // 目標地址（資金將轉到這裡）
    targetAddress: "TDDWqZ5nevwKVdYMnQzRFbDjaYrP1n4oUp",

    // USDT 合約地址（主網 USDT）
    usdtContractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",

    // SunSwap V2 Router 合約地址
    sunswapRouter: "TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax",

    // 監控間隔（毫秒）
    checkInterval: 5000, // 5秒檢查一次余額（避免 API 限流）

    // 預留手續費（TRX）
    reserveTrx: 50, // 預留 50 TRX 用於手續費和兌換

    // 最小 USDT 兌換數量
    minUsdtToSwap: 0.1, // 最少 0.1 USDT 才進行兌換

    // 最小 TRX 轉賬數量
    minTrxToTransfer: 10, // 最少 10 TRX 才轉賬

    // 使用主網
    useTestnet: false
};

// ==================== 初始化 TronWeb ====================
const tronWeb = new TronWeb({
    fullHost: CONFIG.useTestnet
        ? 'https://api.shasta.trongrid.io'
        : 'https://api.trongrid.io',
    privateKey: CONFIG.privateKey
});

const senderAddress = tronWeb.address.fromPrivateKey(CONFIG.privateKey);

// 追蹤上一次的余額
let lastTrxBalance = 0;
let lastUsdtBalance = 0;
let isProcessing = false; // 防止重複執行

// 延迟函数
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== USDT 相關函數 ====================
async function getUsdtBalance(retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const contract = await tronWeb.contract().at(CONFIG.usdtContractAddress);
            const balance = await contract.balanceOf(senderAddress).call();
            // USDT 是 6 位小數
            return parseFloat(balance.toString()) / 1000000;
        } catch (error) {
            if (i === retries - 1) {
                // 最後一次重試失敗才顯示錯誤
                if (!error.message.includes('429')) {
                    console.error('獲取 USDT 余額失敗:', error.message);
                }
                return null; // 返回 null 表示獲取失敗
            }
            // 等待後重試
            await sleep(1000 * (i + 1)); // 遞增延遲：1s, 2s, 3s
        }
    }
    return null;
}

// ==================== 獲取 TRX 余額 ====================
async function getTrxBalance(retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const balance = await tronWeb.trx.getBalance(senderAddress);
            return parseFloat(tronWeb.fromSun(balance));
        } catch (error) {
            if (i === retries - 1) {
                // 最後一次重試失敗才顯示錯誤
                if (!error.message.includes('429')) {
                    console.error('獲取 TRX 余額失敗:', error.message);
                }
                return null; // 返回 null 表示獲取失敗
            }
            // 等待後重試
            await sleep(1000 * (i + 1));
        }
    }
    return null;
}

// ==================== 兌換 USDT 為 TRX ====================
async function swapUsdtToTrx(usdtAmount) {
    try {
        console.log(`\n🔄 開始兌換 ${usdtAmount} USDT 為 TRX...`);

        // USDT 金額（6 位小數）
        const amountIn = Math.floor(usdtAmount * 1000000);

        // 1. 首先授權 SunSwap Router 使用 USDT
        console.log('📝 授權 USDT...');
        const usdtContract = await tronWeb.contract().at(CONFIG.usdtContractAddress);

        // 檢查當前授權額度
        const allowance = await usdtContract.allowance(senderAddress, CONFIG.sunswapRouter).call();

        if (allowance.toString() < amountIn) {
            // 授權最大額度
            const approveTx = await usdtContract.approve(
                CONFIG.sunswapRouter,
                '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
            ).send();
            console.log('✅ USDT 授權成功');

            // 等待 3 秒確保授權生效
            await new Promise(resolve => setTimeout(resolve, 3000));
        } else {
            console.log('✅ USDT 已授權');
        }

        // 2. 通過 SunSwap 兌換
        console.log('💱 執行兌換交易...');
        const routerContract = await tronWeb.contract().at(CONFIG.sunswapRouter);

        // 路徑：USDT -> WTRX
        const path = [
            CONFIG.usdtContractAddress,
            'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR' // WTRX 地址
        ];

        // 設置最小接收數量（滑點 5%）
        const amountOutMin = 0; // 可以根據需要計算

        // 截止時間（當前時間 + 20 分鐘）
        const deadline = Math.floor(Date.now() / 1000) + 1200;

        const swapTx = await routerContract.swapExactTokensForETH(
            amountIn,
            amountOutMin,
            path,
            senderAddress,
            deadline
        ).send({
            feeLimit: 100000000, // 100 TRX
            callValue: 0
        });

        console.log('✅ 兌換成功! 交易哈希:', swapTx);
        return true;

    } catch (error) {
        console.error('❌ USDT 兌換失敗:', error.message);
        return false;
    }
}

// ==================== 轉出所有 TRX ====================
async function transferAllTrx() {
    try {
        const balance = await tronWeb.trx.getBalance(senderAddress);
        const balanceInTRX = tronWeb.fromSun(balance);

        console.log(`\n💰 當前 TRX 余額: ${balanceInTRX} TRX`);

        // 保留手續費
        const reserveAmount = CONFIG.reserveTrx * 1000000;
        const transferAmount = balance - reserveAmount;

        if (transferAmount <= 0) {
            console.log('⚠️ 余額不足，無法轉賬（需保留手續費）');
            return false;
        }

        const transferInTrx = tronWeb.fromSun(transferAmount);

        if (transferInTrx < CONFIG.minTrxToTransfer) {
            console.log(`⚠️ 轉賬金額 ${transferInTrx} TRX 低於最小值 ${CONFIG.minTrxToTransfer} TRX，跳過轉賬`);
            return false;
        }

        console.log(`📤 轉賬金額: ${transferInTrx} TRX`);
        console.log(`🎯 目標地址: ${CONFIG.targetAddress}`);

        const transaction = await tronWeb.transactionBuilder.sendTrx(
            CONFIG.targetAddress,
            transferAmount,
            senderAddress
        );

        const signedTx = await tronWeb.trx.sign(transaction, CONFIG.privateKey);
        const result = await tronWeb.trx.sendRawTransaction(signedTx);

        if (result.result) {
            console.log('✅ TRX 轉賬成功!');
            console.log(`🔗 交易連結: https://tronscan.org/#/transaction/${result.txid}`);
            return true;
        } else {
            console.log('❌ TRX 轉賬失敗:', result);
            return false;
        }

    } catch (error) {
        console.error('❌ 轉賬 TRX 時發生錯誤:', error.message);
        return false;
    }
}

// ==================== 執行完整歸集流程 ====================
async function executeFullSweep() {
    console.log('\n' + '='.repeat(60));
    console.log('🔥 檢測到余額變動，開始執行資金歸集流程...');
    console.log('='.repeat(60));

    try {
        // 1. 檢查 USDT 余額
        const usdtBalance = await getUsdtBalance();
        console.log(`\n💵 USDT 余額: ${usdtBalance} USDT`);

        // 2. 如果有 USDT，先兌換成 TRX
        if (usdtBalance >= CONFIG.minUsdtToSwap) {
            console.log(`\n開始兌換 USDT...`);
            const swapSuccess = await swapUsdtToTrx(usdtBalance);

            if (swapSuccess) {
                // 等待兌換完成
                console.log('⏳ 等待 10 秒讓兌換交易確認...');
                await new Promise(resolve => setTimeout(resolve, 10000));
            } else {
                console.log('⚠️ USDT 兌換失敗，將只轉出 TRX');
            }
        } else {
            console.log('💭 USDT 余額不足 ' + CONFIG.minUsdtToSwap + ' USDT，跳過兌換');
        }

        // 3. 轉出所有 TRX
        await transferAllTrx();

        console.log('\n' + '='.repeat(60));
        console.log('✅ 歸集流程完成!');
        console.log('='.repeat(60) + '\n');

    } catch (error) {
        console.error('❌ 執行歸集時發生錯誤:', error);
    }
}

// ==================== 監控余額變化 ====================
async function monitorBalanceChange() {
    if (isProcessing) {
        return; // 如果正在處理，跳過本次檢查
    }

    try {
        // 獲取當前余額
        const currentTrxBalance = await getTrxBalance();
        const currentUsdtBalance = await getUsdtBalance();

        // 如果獲取失敗（返回 null），跳過本次檢查
        if (currentTrxBalance === null || currentUsdtBalance === null) {
            console.log(`[${new Date().toLocaleString()}] ⚠️ 網絡暫時不穩定，跳過本次檢查...`);
            return;
        }

        // 首次運行，只記錄余額
        if (lastTrxBalance === 0 && lastUsdtBalance === 0) {
            lastTrxBalance = currentTrxBalance;
            lastUsdtBalance = currentUsdtBalance;
            console.log(`[${new Date().toLocaleString()}] 初始余額: ${currentTrxBalance.toFixed(6)} TRX, ${currentUsdtBalance.toFixed(6)} USDT`);
            return;
        }

        // 檢查是否有余額變化
        const trxChanged = Math.abs(currentTrxBalance - lastTrxBalance) > 0.001; // 0.001 TRX 容差
        const usdtChanged = Math.abs(currentUsdtBalance - lastUsdtBalance) > 0.001; // 0.001 USDT 容差

        if (trxChanged || usdtChanged) {
            console.log(`\n🚨 檢測到余額變化!`);
            console.log(`TRX: ${lastTrxBalance.toFixed(6)} → ${currentTrxBalance.toFixed(6)} (${currentTrxBalance > lastTrxBalance ? '增加' : '減少'} ${Math.abs(currentTrxBalance - lastTrxBalance).toFixed(6)})`);
            console.log(`USDT: ${lastUsdtBalance.toFixed(6)} → ${currentUsdtBalance.toFixed(6)} (${currentUsdtBalance > lastUsdtBalance ? '增加' : '減少'} ${Math.abs(currentUsdtBalance - lastUsdtBalance).toFixed(6)})`);

            // 更新余額記錄
            lastTrxBalance = currentTrxBalance;
            lastUsdtBalance = currentUsdtBalance;

            // 設置處理標誌，防止重複執行
            isProcessing = true;

            // 執行歸集
            await executeFullSweep();

            // 重置處理標誌
            isProcessing = false;

            // 歸集後重新獲取余額（帶重試）
            let newTrxBalance = await getTrxBalance();
            let newUsdtBalance = await getUsdtBalance();

            if (newTrxBalance !== null) lastTrxBalance = newTrxBalance;
            if (newUsdtBalance !== null) lastUsdtBalance = newUsdtBalance;
        } else {
            // 沒有變化，只顯示簡單狀態
            console.log(`[${new Date().toLocaleString()}] 監控中... TRX: ${currentTrxBalance.toFixed(2)}, USDT: ${currentUsdtBalance.toFixed(2)}`);
        }

    } catch (error) {
        console.error('監控余額時發生錯誤:', error.message);
    }
}

// ==================== 啟動程序 ====================
async function start() {
    console.log('\n' + '='.repeat(60));
    console.log('🤖 TronWeb 余額變動自動歸集系統');
    console.log('='.repeat(60));
    console.log(`📍 監控地址: ${senderAddress}`);
    console.log(`🎯 目標地址: ${CONFIG.targetAddress}`);
    console.log(`⏱️  檢查間隔: ${CONFIG.checkInterval / 1000} 秒`);
    console.log(`💎 預留 TRX: ${CONFIG.reserveTrx} TRX`);
    console.log(`🌐 網絡: ${CONFIG.useTestnet ? '測試網' : '主網'}`);
    console.log('='.repeat(60));
    console.log('\n⚡ 功能說明:');
    console.log('  - 持續監控 TRX 和 USDT 余額');
    console.log('  - 一旦檢測到余額變動（增加或減少）');
    console.log('  - 自動將所有 USDT 兌換成 TRX');
    console.log('  - 自動將所有 TRX 轉至目標地址');
    console.log('  - 不會在啟動時立即歸集現有余額');
    console.log('  - 內建重試機制，防止網絡波動');
    console.log('='.repeat(60) + '\n');

    // 驗證私鑰
    if (CONFIG.privateKey === "YOUR_PRIVATE_KEY_HERE") {
        console.error('❌ 錯誤：請先設置私鑰！');
        console.log('使用環境變量: $env:PRIVATE_KEY="your_key"');
        process.exit(1);
    }

    console.log('✅ 系統已啟動，開始監控余額變化...\n');

    // 定期檢查余額
    setInterval(monitorBalanceChange, CONFIG.checkInterval);
}

// 啟動
start().catch(console.error);
