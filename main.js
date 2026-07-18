require('dotenv').config()
const amqp = require('amqplib')
const DataStream = require('./StockDataStream')
const connectDB = require('./dbConnect')
const mongoose = require('mongoose')
const { io } = require('socket.io-client')
const TickerWatch = require('./models/TickerWatch')
const MacroTickerWatch = require('./models/MacroTickerWatch')





const usersLoggedIn = []
const tempTickersPerUser = {} //{tickerSymbol:[userId1,userId2],tickerSymbol:[userId3,userId2]}
const tempTickerQuotesPerUser = {}
let macroTickersDefaultToEveryUser = []
// ['SPY', 'DIA', 'QQQ', 'IWM', 'TLT', 'XLRE', 'XLY', 'XLK', 'XLF', 'XLU', 'XLP', 'XLE',
//     'XLC', 'XLI', 'XLV', 'XLB', 'GLD', 'SLV', 'GDX', 'SMH', 'XBI', 'KRE', 'XOP', 'XRT']

//const watchListTickersPerUser = {} //tickerSymbol:[userId]

const rabbitQueueNames = {
    loggedInEnterExitPlanQueue: 'enterExitWatchListPrice',
    loggedInActiveTradeQueue: 'activeTradePrice',
    initiateTrackingQueueName: 'TickerUserTracking_initiateQueue',
    updateTrackingQueueName: 'TickerUserTracking_updateQueue',
    userLoggingInQueueName: 'UserLoggedIn_Queue',
    singleGraphTickerQueue: 'SingleTicker_temporaryTradeQueue',
    removeTempTickerQueue: 'removeTempTicker',
    enterExitTradeQueue: 'enterExitTradeQueue',
    loggedInWatchListQueue: 'loggedInWatchListQueue',
    updateEMAlertQueue: 'updateEMAlert',
    liveQuotesSubscribe: 'liveQuotesSubscribe'

}

let rabbitConnection = undefined
let rabbitChannel = undefined


//////////////////////////////////////////////////////////////////////////////////////
////////////////      Establish websocket connection to frontend       ///////////////
//////////////////////////////////////////////////////////////////////////////////////
let socketConnection = false
const socketToFront = io.connect('http://localhost:8080')
socketToFront.on('connect', () =>           
{
    socketConnection = true
    console.log('Stock Trade Monitor Connected to Frontend Socket')
    socketToFront.emit('monitorServerConnected', { connectionId: 'Stock Trade Monitor Server' })
})

//////////////////////////////////////////////////////////////////////////////////////
///////////      Establish AlpacaStream Object and Connect To MongoDB       //////////
//////////////////////////////////////////////////////////////////////////////////////
let mongooseConnection = false
let alpacaStream = new DataStream({ apiKey: process.env.ALPACA_API_PAPER, secretKey: process.env.ALPACA_API_PAPER_SECRET, paper: true });
let timeOutAttemptToReconnect
alpacaStream.socket.onConnect(() =>
{
    connectDB()
    fetchInitialTickers()
    // if (mongooseConnection) {         fetchInitialTickers()     }
    // else connectDB()
    if (timeOutAttemptToReconnect) clearTimeout(timeOutAttemptToReconnect)
    connectionEstablished = true
});

alpacaStream.socket.onError(() =>
{
    console.log('Error with alpaca stream')
})

alpacaStream.socket.onDisconnect(() =>
{
    console.log("Disconnected From Alpaca Data Stream");
    connectionEstablished = false
    timeOutAttemptToReconnect = setTimeout(() => { alpacaStream.socket.connect() }, 8000);
})


let suppliedMacroTickersForSTD = {}

//////////////////////////////////////////////////////////////////////////////////////
///////////      MongoDB initial pull of trade/bar tickers for Alpaca       //////////
//////////////////////////////////////////////////////////////////////////////////////
mongoose.connection.once('open', () =>
{
    console.log('Connected To MongoDB')
    console.log('Fetching initial list of stocks from DB')
    mongooseConnection = true
    fetchInitialTickers()
    fetchInitialMacroTickers()

    startConnectionToRabbitMQ(alpacaStream)



    async function fetchInitialMacroTickers()
    {
        try
        {
            let results = await MacroTickerWatch.find({})
            macroTickersDefaultToEveryUser = results.map((watchInfo, i) =>
            {
                suppliedMacroTickersForSTD[watchInfo._id] = { watch: watchInfo.watchInfo[0], mostRecentDailyLevel: 2 }
                return watchInfo._id
            })
            if (alpacaStream && macroTickersDefaultToEveryUser.length > 0) alpacaStream.addTickerToAlpacaDataStream(macroTickersDefaultToEveryUser)
        } catch (error)
        {
            console.log(error)
        }
    }
})
async function fetchInitialTickers()
{
    try
    {
        const results = await TickerWatch.find({}, { _id: 1 })
        let tradeTickersFromDB = results.map((watchInfo, i) => { return watchInfo._id })
        if (alpacaStream && tradeTickersFromDB.length > 0) alpacaStream.addTickerToAlpacaDataStream(tradeTickersFromDB)
    } catch (error)
    {
        console.log(error)
    }
}

//////////////////////////////////////////////////////////////////////////////////////
///////      RabbitMQ connection and function calls upon message received       //////
//////////////////////////////////////////////////////////////////////////////////////
async function startConnectionToRabbitMQ(tickerDataStream)
{
    try
    {
        rabbitConnection = await amqp.connect('amqp://localhost')
        rabbitChannel = await rabbitConnection.createChannel()

        await rabbitChannel.assertQueue(rabbitQueueNames.userLoggingInQueueName, { durable: true })
        await rabbitChannel.assertQueue(rabbitQueueNames.initiateTrackingQueueName, { durable: true })
        await rabbitChannel.assertQueue(rabbitQueueNames.updateTrackingQueueName, { durable: true })
        await rabbitChannel.assertQueue(rabbitQueueNames.enterExitTradeQueue, { durable: true })
        await rabbitChannel.assertQueue(rabbitQueueNames.singleGraphTickerQueue, { durable: true })
        await rabbitChannel.assertQueue(rabbitQueueNames.removeTempTickerQueue, { durable: true })
        await rabbitChannel.assertQueue(rabbitQueueNames.loggedInWatchListQueue, { durable: true })
        await rabbitChannel.assertQueue(rabbitQueueNames.updateEMAlertQueue, { durable: true })
        await rabbitChannel.assertQueue(rabbitQueueNames.liveQuotesSubscribe, { durable: true })
        rabbitChannel.prefetch(1)
        console.log('Consumer connected to RabbitMQ. Waiting for message')


        //Adds userId to logged in users and sends their plan/active trade relays as Trade data comes in
        rabbitChannel.consume(rabbitQueueNames.userLoggingInQueueName, (msg) =>
        {
            if (msg)
            {
                const content = JSON.parse(msg.content.toString());
                if (content.data.refreshDBTickersForStream) { fetchInitialTickers() }
                if (!usersLoggedIn.includes(content.data.userId)) { usersLoggedIn.push(content.data.userId) }
                rabbitChannel.ack(msg);
            }
        })

        //Add ticker to quote and trade stream for deep discount watch
        rabbitChannel.consume(rabbitQueueNames.liveQuotesSubscribe, (msg) =>
        {
            if (msg)
            {
                const content = JSON.parse(msg.content.toString())
                try { initiateRemoveSingleTickerQuoteStream(content, tickerDataStream) }
                catch (error)
                {
                    console.error(`Error occurred trying to initiate a quote stream for ${content.data.tickerSymbol} via liveQuotesSubscribe`)
                    console.log(error)
                }
                try { initiateSingleTickerStream(content, tickerDataStream) }
                catch (error)
                {
                    console.error(`Error occurred trying to add ${content.data.tickerSymbol} to Temp Ticker stream via liveQuotesSubscribe`)
                    console.log(error)
                }
                rabbitChannel.ack(msg)
            }
        })



        //Listening for new or updated Planned Stocks
        rabbitChannel.consume(rabbitQueueNames.initiateTrackingQueueName, (msg) =>
        {
            if (msg)
            {
                const content = JSON.parse(msg.content.toString());
                //console.log(`Message received on the Initiate Queue for adding ${content.data.tickerSymbol} via user ${content.data.userId}.`)
                findOrCreateTickerWatch(content, tickerDataStream)
                rabbitChannel.ack(msg);
            }
        }, { noAck: false });
        rabbitChannel.consume(rabbitQueueNames.updateTrackingQueueName, (msg) =>
        {
            if (msg)
            {
                const content = JSON.parse(msg.content.toString());
                if (content.data?.remove) { removeUsersTickerWatch(content.data) }
                else { updateUsersTickerWatchPricePoints(content.data) }
                rabbitChannel.ack(msg);
            }
        }, { noAck: false });



        //Active Trade Entering and Exiting 
        rabbitChannel.consume(rabbitQueueNames.enterExitTradeQueue, (msg) =>
        {
            if (msg)
            {
                const content = JSON.parse(msg.content.toString())

                if (content.data.action === 'enter') updateTickerWatchToTradeWithEnterPrice(content.data)
                else if (content.data.action === 'exit') removeUsersPricePoints(content.data)

                rabbitChannel.ack(msg)
            }
        }, { noAck: false })



        //Streaming Trade Relays for Temporary Tickers
        rabbitChannel.consume(rabbitQueueNames.singleGraphTickerQueue, (msg) =>
        {
            if (msg)
            {
                const content = JSON.parse(msg.content.toString())
                //console.log(`Attempting to add ${content.data.tickerSymbol} to temp ticker stream via singleGraphTickerQueue.`)
                try { initiateSingleTickerStream(content, tickerDataStream) }
                catch (error) { console.error(`Error occurred trying to add ${content.data.tickerSymbol} to Temp Ticker stream via singleGraphTickerQueue`) }
                rabbitChannel.ack(msg)
            }
        }, { noAck: false })
        rabbitChannel.consume(rabbitQueueNames.removeTempTickerQueue, (msg) =>
        {
            if (msg)
            {
                const content = JSON.parse(msg.content.toString())
                try { removeSingleTickerStream(content, tickerDataStream) }
                catch (error) { console.log(`Error occurred trying attempting to remove ${content.tickerSymbol} from Temp Ticker stream via RemoveTempTickerQueue`) }
                rabbitChannel.ack(msg)
            }
        }, { noAck: false })


        rabbitChannel.consume(rabbitQueueNames.updateEMAlertQueue, (msg) =>
        {
            if (msg)
            {
                const content = JSON.parse(msg.content.toString())
                reFetchMacroSTD()
                rabbitChannel.ack(msg)
            }
        }, { noAck: false })


    } catch (error)
    {
        console.error('Error in consumer:', error);
    }
}

async function reFetchMacroSTD()
{
    try
    {
        let results = await MacroTickerWatch.find({})
        results.map((watchInfo, i) => { suppliedMacroTickersForSTD[watchInfo._id] = { watch: watchInfo.watchInfo[0], mostRecentDailyLevel: 2 } })
    } catch (error)
    {
        console.log(error)
    }
}


//adding,updating,removing plans to TickerWatch (exiting a trade removes TickerWatch)
async function findOrCreateTickerWatch(content, tickerDataStream)
{
    try
    {
        let entry = content.data
        const foundWatchTicker = await TickerWatch.findById(entry.tickerSymbol)

        if (foundWatchTicker)
        {
            let tickerNeedsToBeAddedToWatchInfo = true

            foundWatchTicker.watchInfo = foundWatchTicker.watchInfo.map((info, i) =>
            {
                if (info.userId === entry.userId)
                {
                    tickerNeedsToBeAddedToWatchInfo = false
                    return entry
                } else return info
            })

            if (tickerNeedsToBeAddedToWatchInfo) { foundWatchTicker.watchInfo = foundWatchTicker.watchInfo.push(entry) }
            foundWatchTicker.markModified('watchInfo')
            await foundWatchTicker.save()
        } else
        {
            let watchToCreate = {
                _id: entry.tickerSymbol,
                watchInfo: [{
                    userId: entry.userId, plannedTradeId: entry.plannedTradeId, pricePoints: entry.pricePoints,
                    tradeStatus: entry.tradeStatus, purpose: 0
                }]
            }
            await TickerWatch.create(watchToCreate)
            tickerDataStream.addTickerToAlpacaDataStream([entry.tickerSymbol])
        }
    } catch (error)
    {
        console.log(error)
    }
}
async function updateUsersTickerWatchPricePoints(updateMessage)
{
    const foundTickerWatch = await TickerWatch.findById(updateMessage.tickerSymbol)
    if (!foundTickerWatch) return console.log('Ticker watch was not found.')

    const watchReplace = {
        _id: foundTickerWatch._id,
        watchInfo: foundTickerWatch.watchInfo.map((userPrice, i) =>
        {
            if (userPrice.userId === updateMessage.userId) { return { ...userPrice, pricePoints: updateMessage.pricePoints } }
            else { return userPrice }
        }),
    }

    await TickerWatch.findByIdAndUpdate(updateMessage.Symbol, watchReplace)
}
async function removeUsersTickerWatch(updateMessage)
{
    if (Array.isArray(updateMessage.tickerSymbol))
    {
        let tickerConfirmedForRemoval = []
        for (const tickerToBeRemovedOrUpdated of updateMessage.tickerSymbol)
        {
            const foundTicker = await TickerWatch.findById(tickerToBeRemovedOrUpdated)
            if (!foundTicker) return

            const watchReplace = {
                _id: foundTicker._id,
                watchInfo: foundTicker.watchInfo.filter((userWatchInfo, i) =>
                { userWatchInfo.userId !== updateMessage.userId })
            }

            if (watchReplace.watchInfo.length === 0) { tickerConfirmedForRemoval.push(watchReplace._id) }
            else { TickerWatch.findByIdAndUpdate(updateMessage.Symbol, watchReplace) }
        }

        const removalResult = await TickerWatch.deleteMany({ _id: { $in: tickerConfirmedForRemoval } })
        if (alpacaStream) alpacaStream.removeTickerFromAlpacaDataStream(tickerConfirmedForRemoval)
    } else
    {
        const foundTicker = await TickerWatch.findById(updateMessage.tickerSymbol)
        if (!foundTicker) return

        const watchReplace = {
            _id: foundTicker._id,
            watchInfo: foundTicker.watchInfo.filter((userWatchInfo, i) =>
            { userWatchInfo.userId !== updateMessage.userId })
        }

        if (watchReplace.watchInfo.length === 0)
        {
            await TickerWatch.findByIdAndDelete(updateMessage.tickerSymbol)
            if (alpacaStream) alpacaStream.removeTickerFromAlpacaDataStream([updateMessage.tickerSymbol])
        }
        else { await TickerWatch.findByIdAndUpdate(updateMessage.tickerSymbol, watchReplace) }
    }
}




//setting a plan to Active Trade such that it will send trade relays to the active trade listener instead of planned stock listener
async function updateTickerWatchToTradeWithEnterPrice(updateMessage)
{
    if (!updateMessage.tickerSymbol) return console.log('Symbol was not provided to update')

    const foundTicker = await TickerWatch.findById(updateMessage.tickerSymbol)
    if (!foundTicker) return console.log('Ticker watch was not found.')

    const watchReplace = {
        _id: foundTicker._id,
        watchInfo: foundTicker.watchInfo.map((userWatchInfo, i) =>
        {
            if (userWatchInfo.userId === updateMessage.userId)
            {
                userWatchInfo.pricePoints[1] = updateMessage.tradeEnterPrice
                userWatchInfo.purpose = 1
            }
            return userWatchInfo
        })
    }

    await TickerWatch.findByIdAndUpdate(updateMessage.tickerSymbol, watchReplace)
}






//adds a temporary Ticker stream associated with the userId
async function initiateSingleTickerStream(content, tickerDataStream)
{
    const { tickerSymbol, userId } = content.data
    if (!tickerSymbol || !userId) return console.log('Missing fields upon single ticker stream initiate')

    if (tickerSymbol in tempTickersPerUser)
    {
        if (!tempTickersPerUser[tickerSymbol].includes(userId)) { tempTickersPerUser[tickerSymbol].push(userId) }
    } else
    {
        tempTickersPerUser[tickerSymbol] = [userId]
        tickerDataStream.addTickerToAlpacaDataStream([tickerSymbol])
    }
}
async function removeSingleTickerStream(content, tickerDataStream)
{
    let { tickerSymbol, userId } = content
    if (!tickerSymbol || !userId) return console.log('Missing required information from remove single ticker stream')

    const foundTickerWatch = await TickerWatch.findById(tickerSymbol)
    if (foundTickerWatch)
    {
        foundTickerWatch.watchInfo.forEach((singleUserWatchInfo) => { if (singleUserWatchInfo.userId.toString() === userId) { filterUserIdFromTempTickerAndCheckForLength(); return } })
    } else
    {
        filterUserIdFromTempTickerAndCheckForLength()
        tickerDataStream.removeTickerFromAlpacaDataStream([tickerSymbol])
    }

    function filterUserIdFromTempTickerAndCheckForLength()
    {
        if (tickerSymbol in tempTickersPerUser)
        {
            tempTickersPerUser[tickerSymbol] = tempTickersPerUser[tickerSymbol].filter(t => t !== userId)
            if (tempTickersPerUser[tickerSymbol].length === 0) delete tempTickersPerUser[tickerSymbol]
        }
    }
}


//add quote and trade stream associated with the userId
async function initiateRemoveSingleTickerQuoteStream(content, tickerDataStream)
{
    const { tickerSymbol, userId, isAddingQuote } = content.data
    if (!tickerSymbol || !userId) return console.log('Missing fields upon single ticker quote stream initiate.')

    if (isAddingQuote)
    {

        if (tickerSymbol in tempTickerQuotesPerUser)
        {
            if (!tempTickerQuotesPerUser[tickerSymbol].includes(userId)) { tempTickerQuotesPerUser[tickerSymbol].push(userId) }
        } else
        {
            tempTickerQuotesPerUser[tickerSymbol] = [userId]
            tickerDataStream.addTickerToAlpacaQuoteStream([tickerSymbol])
        }
    } else
    {
        if (tickerSymbol in tempTickerQuotesPerUser)
        {
            tempTickerQuotesPerUser[tickerSymbol] = tempTickerQuotesPerUser[tickerSymbol].filter((t) => t !== userId)
            if (tempTickerQuotesPerUser[tickerSymbol].length === 0) delete tempTickerQuotesPerUser[tickerSymbol]
        }
        tickerDataStream.removeTickerFromAlpacaQuoteStream([tickerSymbol])
    }
}












//////////////////////////////////////////////////////////////////////////////////////
/////           response to incoming alpaca onTrade data stream events            ////
//////////////////////////////////////////////////////////////////////////////////////
alpacaStream.socket.onStockTrade((trade) =>
{
    checkIfDefaultMacroTrade(trade)
    checkIfUserIsLoggedInForTradeStream(trade)
    relayTradeToAnyTempUserTicker(trade)
})

alpacaStream.socket.onStockQuote((quote) =>
{
    try
    {
        if (socketConnection && quote.Symbol in tempTickerQuotesPerUser && tempTickerQuotesPerUser[quote.Symbol].length > 0)
        {
            socketToFront.emit('quoteStream', { users: tempTickerQuotesPerUser[quote.Symbol], quote })
        }
    } catch (error)
    {
        console.log(error)
    }
})


async function checkIfDefaultMacroTrade(trade)
{
    if (macroTickersDefaultToEveryUser.includes(trade.Symbol) && socketConnection)
    {
        socketToFront.emit('macroWatchListUpdate', { users: usersLoggedIn, trade })
        checkForSTDChange(trade)
    }
}

async function checkForSTDChange(trade)
{
    if (suppliedMacroTickersForSTD[trade.Symbol])
    {
        const index = suppliedMacroTickersForSTD[trade.Symbol].watch.dailyEM.findIndex(num => num >= trade.Price);
        if (index !== 2)
        {
            switch (index)
            {
                case 0:
                    if (suppliedMacroTickersForSTD[trade.Symbol].mostRecentDailyLevel !== 0)
                    {
                        // console.log(`${trade.Symbol} below daily 2std`);
                        // console.log('below daily 2std');
                        socketToFront.emit('coreSTDHit', {
                            users: usersLoggedIn, tradeInfo: {
                                Symbol: trade.Symbol, Price: trade.Price,
                                std: 'daily2Std', direction: 'Lower', EM: suppliedMacroTickersForSTD[trade.Symbol].watch.dailyEM, timeStamp: new Date()
                            }
                        })
                        suppliedMacroTickersForSTD[trade.Symbol].mostRecentDailyLevel = 0
                    }
                    break;
                case 1:
                    if (suppliedMacroTickersForSTD[trade.Symbol].mostRecentDailyLevel !== 1)
                    {
                        // console.log(`${trade.Symbol} below daily 1std`);
                        // console.log('sending alert message via stream')
                        socketToFront.emit('coreSTDHit', {
                            users: usersLoggedIn, tradeInfo: {
                                Symbol: trade.Symbol, Price: trade.Price,
                                std: 'daily1Std', direction: 'Lower', EM: suppliedMacroTickersForSTD[trade.Symbol].watch.dailyEM, timeStamp: new Date()
                            }
                        })
                        suppliedMacroTickersForSTD[trade.Symbol].mostRecentDailyLevel = 1
                    }
                    break;
                case 3:
                    if (suppliedMacroTickersForSTD[trade.Symbol].mostRecentDailyLevel !== 3)
                    {
                        // console.log(`${trade.Symbol} above daily 1std`);
                        // console.log('sending alert message via stream')
                        socketToFront.emit('coreSTDHit', {
                            users: usersLoggedIn, tradeInfo: {
                                Symbol: trade.Symbol, Price: trade.Price,
                                std: 'daily1Std', direction: 'Upper', EM: suppliedMacroTickersForSTD[trade.Symbol].watch.dailyEM, timeStamp: new Date()
                            }
                        })
                        suppliedMacroTickersForSTD[trade.Symbol].mostRecentDailyLevel = 3
                    }
                    break;
                default: if (suppliedMacroTickersForSTD[trade.Symbol].mostRecentDailyLevel !== 4)
                {
                    // console.log(`${trade.Symbol} above daily 2std`);
                    // console.log('sending alert message via stream')
                    socketToFront.emit('coreSTDHit', {
                        users: usersLoggedIn, tradeInfo: {
                            Symbol: trade.Symbol, Price: trade.Price,
                            std: 'daily2Std', direction: 'Upper', EM: suppliedMacroTickersForSTD[trade.Symbol].watch.dailyEM, timeStamp: new Date()
                        }
                    })
                    suppliedMacroTickersForSTD[trade.Symbol].mostRecentDailyLevel = 4
                }
                    break;
            }
        } else if (suppliedMacroTickersForSTD[trade.Symbol].mostRecentDailyLevel !== 2)
        {
            suppliedMacroTickersForSTD[trade.Symbol].mostRecentDailyLevel = 2
        }
    }
}

async function checkIfUserIsLoggedInForTradeStream(trade)
{
    try
    {
        const foundSymbol = await TickerWatch.findById(trade.Symbol)
        if (!foundSymbol) return

        foundSymbol.watchInfo.forEach((singleWatch) =>
        {
            if (!usersLoggedIn.includes(singleWatch.userId))
            {
                console.log('user not logged in')
                return
            }

            switch (singleWatch.purpose)
            {
                case -1: sendUserWatchListTradeRelayMessage(); break;//Only watchlist
                case 0: sendUserPlanTradeRelayMessage(singleWatch, trade); break; //PlannedStock
                case 1: sendUserActiveTradeRelayMessage(singleWatch, trade); break; //ActiveTradeStock
            }

            if (singleWatch.belowThisPriceAlert.length > 0)
            {
                let lowestPriceAlert
                singleWatch.belowThisPriceAlert.forEach((t) =>
                {
                    if (trade.Price < t.price)
                    {
                        if (!lowestPriceAlert) lowestPriceAlert = t
                        else
                        {
                            if (lowestPriceAlert.price > t.price) lowestPriceAlert = t
                        }
                    }
                })
                if (lowestPriceAlert) sendPriceAlertRelayMessage(singleWatch, lowestPriceAlert, true, trade)
            }

            if (singleWatch.aboveThisPriceAlert.length > 0)
            {
                let highestPriceAlert
                singleWatch.aboveThisPriceAlert.forEach((t) =>
                {
                    if (trade.Price > t.price)
                    {
                        if (!highestPriceAlert) highestPriceAlert = t
                        else { if (highestPriceAlert.price > t.price) highestPriceAlert = t }
                    }
                })
                if (highestPriceAlert) sendPriceAlertRelayMessage(singleWatch, highestPriceAlert, false, trade)
            }
        })

    } catch (error)
    {
        console.log(`Error checking trade ${trade.Symbol} against DB and for logged in users.`)
    }

}




async function relayTradeToAnyTempUserTicker(trade)
{
    try
    {
        if (socketConnection && trade.Symbol in tempTickersPerUser && tempTickersPerUser[trade.Symbol].length > 0)
        {
            socketToFront.emit('tradeStream', { users: tempTickersPerUser[trade.Symbol], trade })
        }

    } catch (error)
    {
        console.log(error)
    }
}









//////////////////////////////////////////////////////////////////////////////////////
////////////////////      functions for outgoing broadcasts       ////////////////////
//////////////////////////////////////////////////////////////////////////////////////
async function sendUserPlanTradeRelayMessage(singleWatch, trade)
{
    let outgoingMessageDetails = {
        userId: singleWatch.userId,
        tickerSymbol: trade.Symbol,
        plannedId: singleWatch.plannedTradeId,
        pricePoints: singleWatch.pricePoints,
        tradePrice: trade.Price,
        size: trade.Size,
        trade: trade,
        includedInUserWatchList: singleWatch.watchListIncluded
    }

    try
    {
        await rabbitChannel.sendToQueue(rabbitQueueNames.loggedInEnterExitPlanQueue, Buffer.from(JSON.stringify(outgoingMessageDetails)), { persistent: false })
        // console.log(`${outgoingMessageDetails.tickerSymbol} - ${outgoingMessageDetails.tradePrice}`)
    } catch (error)
    {
        console.error(`Trade Stream Producer failed to send enter/exit plan price update for ticker ${trade.Symbol} and user: ${singleWatch.userId}.`, error);
    }
}
async function sendUserActiveTradeRelayMessage(singleWatch, trade)
{
    let outgoingMessageDetails = {
        userId: singleWatch.userId,
        tickerSymbol: trade.Symbol,
        plannedId: singleWatch.plannedTradeId,
        pricePoints: singleWatch.pricePoints,
        Price: trade.Price,
        Size: trade.Size,
        Timestamp: trade.Timestamp,
        includedInUserWatchList: singleWatch.watchListIncluded
    }

    try
    {
        await rabbitChannel.sendToQueue(rabbitQueueNames.loggedInActiveTradeQueue, Buffer.from(JSON.stringify(outgoingMessageDetails)), { persistent: false })
        // console.log(`Trade sent for ${outgoingMessageDetails.tickerSymbol} - ${outgoingMessageDetails.Price} via active Trade`)
    } catch (error)
    {
        console.error(`Trade Stream Producer failed to send active trade price update for ticker ${trade.Symbol} and user: ${singleWatch.userId}.`, error);
    }
}
async function sendUserWatchListTradeRelayMessage(singleWatch, trade)
{
    let outgoingMessageDetails = {
        userId: singleWatch.userId,
        tickerSymbol: trade.Symbol,
        plannedId: singleWatch.plannedTradeId,
        pricePoints: singleWatch.pricePoints,
        tradePrice: trade.Price,
        includedInUserWatchList: singleWatch.watchListIncluded
    }

    try
    {
        console.log(`Trade Stream Producer sent active trade price update for user ${singleWatch.userId}.`)
        await rabbitChannel.sendToQueue(rabbitQueueNames.loggedInWatchListQueue, Buffer.from(JSON.stringify(outgoingMessageDetails)), { persistent: false })
    } catch (error)
    {
        console.error(`Trade Stream Producer failed to send active trade price update for ticker ${trade.Symbol} and user: ${singleWatch.userId}.`, error);
    }
}


async function sendPriceAlertRelayMessage(singleWatch, priceAlert, aboveOrBelow, trade)
{
    socketToFront.emit('priceAlert', {
        Symbol: trade.Symbol, Price: trade.Price, plannedTradeId: singleWatch.plannedTradeId, userId: singleWatch.userId,
        priceAlert, belowAlertPrice: aboveOrBelow, timeStamp: new Date()
    })
}

