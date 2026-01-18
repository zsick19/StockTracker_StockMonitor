require('dotenv').config()
const amqp = require('amqplib')
const DataStream = require('./StockDataStream')
const connectDB = require('./dbConnect')
const mongoose = require('mongoose')
const { io } = require('socket.io-client')
const TickerWatch = require('./models/TickerWatch')
const NotificationMsg = require('./models/NotificationMsg')



let usersLoggedIn = []
const tempTradesDataStreams = {}
const tempSourcesWithTickers = {}


const rabbitQueueNames = {
    loggedInEnterExitPlanQueue: 'enterExitWatchListPrice',
    loggedInActiveTradeQueue: 'activeTradePrice',
    initiateTrackingQueueName: 'TickerUserTracking_initiateQueue',
    updateTrackingQueueName: 'TickerUserTracking_updateQueue',
    userLoggingInQueueName: 'UserLoggedIn_Queue',
    singleGraphTickerQueue: 'SingleTicker_temporaryTradeQueue',
    removeTempTickerQueue: 'removeTempTicker'
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

    socketToFront.on('removeTempTradeStream', (msg) =>
    {
        try
        {
            const { userId, source } = msg.data
            if (!userId || !source) return console.log('Missing information to remove trade stream')
            // console.log(`Received Request to remove ${source} from stream.`)
            // console.log(tempSourcesWithTickers[userId])

            let tempTickersForUnsubscribeCheck = []
            if (userId in tempSourcesWithTickers)
            {
                //userStreamToEnd should look like 'userId':[{source:'source1',tickers:['Symbol1','Symbol2','Symbol3']},{source:'source2',tickers:['Symbol1']}]
                const userStreamToEnd = tempSourcesWithTickers[userId]


                //remove userId and Source from tempStock object, if ticker array is empty, remove ticker and send ticker for unsubscribe check against DB
                userStreamToEnd.map((sourceTickers, i) =>
                {
                    sourceTickers.tickers.map((ticker, j) =>
                    {
                        if (ticker in tempTradesDataStreams)
                        {
                            let foundFirstOccur = false
                            tempTradesDataStreams[ticker] = tempTradesDataStreams[ticker].filter((t) =>
                            {
                                if (foundFirstOccur) return ticker
                                if (t.userId !== userId) return ticker
                                if (t.source !== source) return ticker

                                if (!foundFirstOccur) { foundFirstOccur = true }
                                // else { return ticker }
                            })

                            if (tempTradesDataStreams[ticker].length === 0)
                            {
                                tempTickersForUnsubscribeCheck.push(ticker)
                                delete tempTradesDataStreams[ticker]
                            }
                        }
                    })
                })

                //from tempSourceWTickers, remove source and ticker object
                let foundFirstOccur = false
                tempSourcesWithTickers[userId] = userStreamToEnd.filter((t) =>
                {
                    if (foundFirstOccur) return t
                    if (t.source !== source) return t
                    if (!foundFirstOccur) { foundFirstOccur = true }
                    // else { return t }
                })
                if (tempSourcesWithTickers[userId].length === 0) { delete tempSourcesWithTickers[userId] }
            }
            // console.log(tempSourcesWithTickers[userId])

            if (tempTickersForUnsubscribeCheck.length > 0)
            {
                tempTickersForUnsubscribeCheck.map(async (ticker) =>
                {
                    try
                    {
                        const foundTickerWatch = await TickerWatch.findById(ticker)
                        if (!foundTickerWatch) { alpacaStream.removeTickerFromAlpacaDataStream([ticker]) }
                    } catch (error)
                    {
                        console.log('Could not check for Ticker Watch upon attempting to remove temp trade stream.')
                    }
                })
            }

        } catch (error)
        {
            console.log(error)
            console.log('Error attempting to remove users stream from tempSource')
        }
    })
})

//////////////////////////////////////////////////////////////////////////////////////
///////////      Establish AlpacaStream Object and Connect To MongoDB       //////////
//////////////////////////////////////////////////////////////////////////////////////
let mongooseConnection = false
let alpacaStream = new DataStream({ apiKey: process.env.ALPACA_API_PAPER, secretKey: process.env.ALPACA_API_PAPER_SECRET, paper: true });
alpacaStream.socket.onConnect(() =>
{
    if (mongooseConnection)
    {
        fetchInitialTickers()
    }
    else
        connectDB()
    connectionEstablished = true
});
alpacaStream.socket.onDisconnect(() =>
{
    console.log("Disconnected From Alpaca Data Stream");
    connectionEstablished = false

    setTimeout(() =>
    {
        alpacaStream.socket.connect()
    }, 5000);

})




//////////////////////////////////////////////////////////////////////////////////////
///////////      MongoDB initial pull of trade/bar tickers for Alpaca       //////////
//////////////////////////////////////////////////////////////////////////////////////
mongoose.connection.once('open', () =>
{
    console.log('Connected To MongoDB')
    console.log('Fetching initial list of stocks from DB')
    mongooseConnection = true
    fetchInitialTickers()
    startConnectionToRabbitMQ(alpacaStream)
})
async function fetchInitialTickers()
{
    try
    {
        const results = await TickerWatch.find({}, { _id: 1 })
        let tradeTickersFromDB = results.map((watchInfo, i) => { return watchInfo._id })

        if (alpacaStream && results.length > 0) { if (tradeTickersFromDB.length > 0) alpacaStream.addTickerToAlpacaDataStream(tradeTickersFromDB) }
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
        await rabbitChannel.assertQueue(rabbitQueueNames.removeTempTickerQueue, { durable: true })



        rabbitChannel.prefetch(1)
        console.log('Consumer connected to RabbitMQ. Waiting for message')
        rabbitChannel.consume(rabbitQueueNames.userLoggingInQueueName, (msg) =>
        {
            if (msg)
            {
                const content = JSON.parse(msg.content.toString());
                console.log(`Message received to add User: ${content.data.userId} to the Logged In User For Plan and Active Trade Streams.`)
                if (!usersLoggedIn.includes(content.data.userId)) usersLoggedIn.push(content.data.userId)
                rabbitChannel.ack(msg);
            }
        })

        rabbitChannel.consume(rabbitQueueNames.initiateTrackingQueueName, (msg) =>
        {
            if (msg)
            {
                const content = JSON.parse(msg.content.toString());
                console.log(content)
                console.log(`Message received on the Initiate Queue for adding ${content.data.Symbol} via user ${content.data.userId}.`)
                findOrCreateTickerWatch(content, tickerDataStream)
                rabbitChannel.ack(msg);
            }
        }, { noAck: false });

        rabbitChannel.consume(rabbitQueueNames.updateTrackingQueueName, (msg) =>
        {
            if (msg)
            {
                const content = JSON.parse(msg.content.toString());

                if (content.data?.remove)
                {
                    // console.log('Message Received on the Update Queue to remove users price points.')
                    const removeTrackingChange = removeUsersPricePoints(content.data)
                    if (removeTrackingChange && alpacaStream)
                    {
                        alpacaStream.removeTickerFromMinuteAndTradeDataStream([content.data.Symbol])
                    }
                } else
                {
                    // console.log('Message Received on the Update Queue to update users price points.')
                    updateUsersPricePoints(content.data, alpacaStream)
                }

                rabbitChannel.ack(msg);
            }
        }, { noAck: false });

        rabbitChannel.consume(rabbitQueueNames.singleGraphTickerQueue, (msg) =>
        {
            if (msg)
            {
                const content = JSON.parse(msg.content.toString())
                console.log(`Set this up for trade relay, ${content}`)
                initiateSingleTickerStream(content, tickerDataStream)
                rabbitChannel.ack(msg)
            }
        }, { noAck: false })

        rabbitChannel.consume(rabbitQueueNames.removeTempTickerQueue, (msg) =>
        {
            if (msg)
            {
                const content = JSON.parse(msg.content.toString())
                console.log(`Set to remove this ticker from stream, ${content?.userId} ${content?.ticker}`)
                removeSingleTickerStream(content, tickerDataStream)
                rabbitChannel.ack(msg)
            }
        }, { noAck: false })

        // rabbitChannel.consume(manageTradeStreamQueueName, (msg) =>
        // {
        //     if (msg)
        //     {
        //         const content = JSON.parse(msg.content.toString())
        //         // console.log('Message received to manage direct trade stream')

        //         initiateTickerStream(content, tickerDataStream)

        //         rabbitChannel.ack(msg)
        //     }
        // }, { noAck: false })

        // rabbitChannel.consume(initiateTradeEnterExitQueueName, (msg) =>
        // {
        //     if (msg)
        //     {
        //         const content = JSON.parse(msg.content.toString())
        //         // console.log(content)
        //         if (content.data.action === 'enter') updateUserEnterPriceUponTradePlaced(content.data)
        //         else if (content.data.action === 'exit') removeUsersPricePoints(content.data)

        //         // console.log('Message received to provide ticker watch with trade execution details.')
        //         rabbitChannel.ack(msg)
        //     }
        // }, { noAck: false })



    } catch (error)
    {
        console.error('Error in consumer:', error);
    }
}


async function findOrCreateTickerWatch(content, tickerDataStream)
{
    try
    {
        let entry = content.data
        const foundWatchTicker = await TickerWatch.findById(entry.Symbol)

        if (foundWatchTicker)
        {
            let userHasNoRecordOfSymbol = true
            foundWatchTicker.watchInfo = foundWatchTicker.watchInfo.map((info, i) =>
            {
                if (info.userId === entry.userId)
                {
                    userHasNoRecordOfSymbol = false
                    // console.log('Ticker Found and PricePoints updated for userId!')
                    return entry
                }
                return info
            })

            if (userHasNoRecordOfSymbol) 
            {
                foundWatchTicker.watchInfo = foundWatchTicker.watchInfo.push(entry)
                // console.log(`Ticker ${entry.Symbol} was found but no tracking record for this user. Users price levels added to TickerWatch!`)
            }

            tickerDataStream.addTickerToAlpacaDataStream([entry.Symbol])
            foundWatchTicker.tradeWatchLevel = true

            foundWatchTicker.markModified('watchInfo')
            await foundWatchTicker.save()
        } else
        {
            let watchToCreate = {
                _id: entry.Symbol,
                watchInfo: [{
                    userId: entry.userId, trackToTradeId: entry.trackToTradeId,
                    pricePoints: entry.pricePoints, tradeStatus: entry.tradeStatus, purpose: 0
                }],
                tradeWatchLevel: true
            }

            tickerDataStream.addTickerToAlpacaDataStream([entry.Symbol])

            await TickerWatch.create(watchToCreate)
            console.log(`Ticker ${entry.Symbol} was not found in TickerWatch but is now supplied with userid:${entry.userId}'s pricing info.`)
        }
    } catch (error)
    {
        console.log(error)
    }
}
async function updateUsersPricePoints(updateMessage)
{
    if (!updateMessage?.Symbol) return console.log('Symbol was not provided to update')
    const foundTicker = await TickerWatch.findById(updateMessage.Symbol)
    if (!foundTicker) return console.log('Ticker watch was not found.')


    const watchReplace = {
        _id: foundTicker._id,
        watchInfo: foundTicker.watchInfo.map((userPrice, i) =>
        {
            if (userPrice.userId.toString() === updateMessage.userId) { return updateMessage } else { return userPrice }
        }),
        tradeWatchLevel: true
    }

    await TickerWatch.findByIdAndUpdate(updateMessage.Symbol, watchReplace)

    // console.log(`${updateMessage.Symbol} pricing was updated for user ${updateMessage.userId}`)
}
async function initiateTickerStream(content, tickerDataStream)
{
    const { tickers, userId, source } = content.data
    if (!tickers || !userId || !source) return console.log('missing fields')

    try
    {
        let streamSourceAlreadyPresent
        if (userId in tempSourcesWithTickers)
        {
            if (source === 'singleStockTrade' || source === 'singleGraph')
            {
                tempSourcesWithTickers[userId].map((t) =>
                {
                    if (t.source === source && t.tickers[0] === tickers[0])
                    {
                        streamSourceAlreadyPresent = true
                        // console.log('You must of refreshed the page because this ticker was already in the temp source with tickers')
                    }
                })
            } else
            {
                tempSourcesWithTickers[userId].map((t) =>
                {
                    if (t.source === source)
                    {
                        streamSourceAlreadyPresent = true
                        // console.log('This source is already accounted for in the temp source with tickers...you cache is long enough')
                    }
                })
            }
        }
        if (streamSourceAlreadyPresent) return

        //check to see if each incoming ticker is already in the tempTrade object, if so then add source and userId
        //if not create ticker key and then add source and userId...push this ticker on to the array to be added to DataStream
        let tickersToAddToDataStream = []
        tickers.map((ticker, i) =>
        {
            if (ticker in tempTradesDataStreams)
            {
                tempTradesDataStreams[ticker].push({ userId, source })
            }
            else
            {
                tempTradesDataStreams[ticker] = [{ userId, source }]
                tickersToAddToDataStream.push(ticker)
            }
        })

        //push stream source and tickers for user onto the temp sources with ticker object for that userId
        if (userId in tempSourcesWithTickers) { tempSourcesWithTickers[userId].push({ source, tickers }) }
        else { tempSourcesWithTickers[userId] = [{ source, tickers: tickersToAddToDataStream }] }


        if (tickersToAddToDataStream.length > 0) { tickerDataStream.addTickerToAlpacaDataStream(tickersToAddToDataStream) }

        // console.log(tempTradesDataStreams)

    } catch (error)
    {
        console.log(error)
    }
}






const tempTickersPerUser = {}
async function initiateSingleTickerStream(content, tickerDataStream)
{
    const { tickerSymbol, userId } = content.data
    if (!tickerSymbol || !userId) return console.log('Missing fields upon single ticker stream initiate')

    let addTickerToAlpacaStream = false

    //check if userId is already in tempTickerPerUser
    if (userId in tempTickersPerUser)
    {
        //if userId is present, ensure the ticker isn't already present
        let tickerFound = false
        tempTickersPerUser[userId].forEach(tempTicker =>
        {
            if (tickerSymbol === tempTicker)
            {
                tickerFound = true
                return
            }
        })

        //if ticker is not in user's temp tickers, add ticker to user's array
        if (!tickerFound)
        {
            tempTickersPerUser[userId].push(tickerSymbol)
            addTickerToAlpacaStream = true
        }
    } else
    {
        //if user is not in tempTickersPerUser at all, add userId and ticker to user's array
        tempTickersPerUser[userId] = [tickerSymbol]
        addTickerToAlpacaStream = true
    }

    if (addTickerToAlpacaStream) { tickerDataStream.addTickerToAlpacaDataStream([tickerSymbol]) }
}

async function removeSingleTickerStream(content, tickerDataStream)
{
    let { ticker, userId } = content
    if (!ticker || !userId) return console.log('Missing required information from remove single ticker stream')

    const foundTickerWatch = await TickerWatch.findById(ticker)

    if (foundTickerWatch)
    {
        let userIsTrackingTicker = false
        foundTickerWatch.watchInfo.forEach((t) =>
        {
            if (t.userId.toString() === userId)
            {
                userIsTrackingTicker = true
                return
            }
        })

        if (userIsTrackingTicker) { tempTickersPerUser[userId] = tempTickersPerUser[userId].filter(t => t !== ticker) }
    } else
    {
        tempTickersPerUser[userId] = tempTickersPerUser[userId].filter(t => t !== ticker)
        tickerDataStream.removeTickerFromAlpacaDataStream([ticker])
    }
}





async function checkForTickerWatchToRemoveTempStream(tickersToCheckAgainstDB)
{
    tickersToCheckAgainstDB.map(async (ticker) =>
    {
        try
        {
            const foundTickerWatch = await TickerWatch.findById(ticker)
            if (!foundTickerWatch && alpacaStream)
            {
                alpacaStream.removeTickerFromAlpacaDataStream([ticker])
            }
        } catch (error)
        {
            console.log('Could not check for Ticker Watch upon attempting to remove temp trade stream.')
        }
    })
}

async function updateUserEnterPriceUponTradePlaced(updateMessage)
{
    if (!updateMessage?.Symbol) return console.log('Symbol was not provided to update')
    const foundTicker = await TickerWatch.findById(updateMessage.Symbol)
    if (!foundTicker) return console.log('Ticker watch was not found.')

    const watchReplace = {
        _id: foundTicker._id,
        watchInfo: foundTicker.watchInfo.map((userPrice, i) =>
        {
            if (userPrice.userId.toString() === updateMessage.userId)
            {
                userPrice.pricePoints[1] = updateMessage.userEnterPriceUpdate
                userPrice.tradeStatus = Math.abs(userPrice.tradeStatus)
            }
            return userPrice
        }),
        tradeWatchLevel: true
    }

    await TickerWatch.findByIdAndUpdate(updateMessage.Symbol, watchReplace)

    // console.log(`${updateMessage.Symbol} for user ${updateMessage.userId} pricing was updated to reflect trade entered.`)
}

async function removeUsersPricePoints(updateMessage)
{
    const foundTicker = await TickerWatch.findById(updateMessage.Symbol)
    if (!foundTicker) return
    const watchReplace = {
        _id: updateMessage.Symbol,
        watchInfo: foundTicker.watchInfo.filter((userPrice, i) =>
        {
            userPrice.userId.toString() !== updateMessage.userId
        }),
        tradeWatchLevel: foundTicker.watchInfo
    }

    if (watchReplace.watchInfo.length === 0)
    {
        // console.log(`${updateMessage.Symbol} no longer has any tracking post trade sell.`)
        await TickerWatch.findByIdAndDelete(updateMessage.Symbol)
        if (alpacaStream) alpacaStream.removeTickerFromAlpacaDataStream([updateMessage.Symbol])
    }
    else
    {
        // console.log(`${updateMessage.Symbol} still has users tracking its price but trade watch for user ${updateMessage.userId} was removed.`)
        await TickerWatch.findByIdAndUpdate(updateMessage.Symbol, watchReplace)
    }
}






//////////////////////////////////////////////////////////////////////////////////////
/////           response to incoming alpaca onTrade data stream events            ////
//////////////////////////////////////////////////////////////////////////////////////
alpacaStream.socket.onStockTrade((trade) =>
{
    checkTradeAgainstDBTicker(trade)
    checkForStreamUser(trade)
})

alpacaStream.socket.onStatuses((s) => { console.log(s) })
alpacaStream.socket.onStateChange((s) => { console.log(s) })


async function checkTradeAgainstDBTicker(trade)
{
    let watchLevel = false
    let statusChange = false
    let priceHitCompare
    try
    {
        const foundSymbol = await TickerWatch.findById(trade.Symbol)
        if (!foundSymbol) return


        priceHitCompare = foundSymbol.watchInfo.map((singleWatch, i) =>
        {

            checkForLoggedInUser(singleWatch, trade)

            let insertionPoint = getInsertionIndexLinear(singleWatch.pricePoints, trade.Price)
            if (singleWatch.tradeStatus < 0 && insertionPoint < 3 && insertionPoint !== Math.abs(singleWatch.tradeStatus))
            {
                statusChange = true
                singleWatch.tradeStatus = (insertionPoint * -1)
                if (singleWatch.tradeStatus > -3)
                {
                    watchLevel = true
                    if (trade.bar)
                    {
                        alpacaStream.addTickerToAlpacaDataStream([trade.Symbol])
                        alpacaStream.removeTickerFromMinuteDataStream([trade.Symbol])
                    }
                }
                sendBufferHitMessage(singleWatch, trade)
            }
            else if (singleWatch.tradeStatus > 0)
            {
                if (insertionPoint !== singleWatch.tradeStatus)
                {
                    statusChange = true
                    singleWatch.tradeStatus = insertionPoint
                    watchLevel = true
                    sendBufferHitMessage(singleWatch, trade)
                }
            }
            // sendBufferHitMessage(singleWatch, trade)
            return singleWatch
        })

        if (statusChange)
        {
            let replacementWatch = { _id: foundSymbol.Symbol, watchInfo: priceHitCompare, tradeWatchLevel: watchLevel }
            await TickerWatch.findOneAndReplace({ _id: trade.Symbol }, replacementWatch)
            console.log('Buffer Price Hit and updated in DB')
        } else { priceHitCompare = null; watchLevel = null; watchLevel = null }

    } catch (error)
    {
        console.log(error, trade.Symbol)
    }

    function getInsertionIndexLinear(arr, num)
    {
        for (let i = 0; i < arr.length; i++)
        {
            if (arr[i] >= num) { return i; }
        }
        return arr.length;
    }
}
async function checkForLoggedInUser(singleWatch, trade)
{
    if (!usersLoggedIn.includes(singleWatch.userId)) return

    switch (singleWatch.purpose)
    {
        case 0: sendUserPlanMessage(singleWatch, trade); break;
        case 1: sendUserActiveTradeMessage(singleWatch, trade); break;
    }
}
async function checkForStreamUser(trade)
{
    try
    {
        if (trade.Symbol in tempTradesDataStreams && socketConnection)
        { socketToFront.emit('tradeStream', { users: tempTradesDataStreams[trade.Symbol], trade }) }
    } catch (error)
    {
        console.log(error)
    }
}


//////////////////////////////////////////////////////////////////////////////////////
////////////////////      functions for outgoing broadcasts       ////////////////////
//////////////////////////////////////////////////////////////////////////////////////
async function sendBufferHitMessage(singleWatch, trade)
{
    let outgoingMessageDetails = {
        userId: singleWatch.userId,
        Symbol: trade.Symbol,
        trackToTradeId: singleWatch.trackToTradeId,
        pricePoints: singleWatch.pricePoints,
        tradePrice: trade.Price,
        tradeStatus: singleWatch.tradeStatus
    }

    await NotificationMsg.deleteMany({ trackToTradeId: outgoingMessageDetails.trackToTradeId })
    const outGoingMsg = await NotificationMsg.create(outgoingMessageDetails)

    let connection;
    try
    {
        connection = await amqp.connect('amqp://localhost');
        const channel = await connection.createChannel();
        const queue = 'pricePointHit_queue';
        await channel.assertQueue(queue, { durable: true }); // Durable queue survives broker restarts


        channel.sendToQueue(queue, Buffer.from(JSON.stringify(outGoingMsg)), { persistent: true });// Persistent messages survive broker restarts
        console.log(`[Producer] Sent Buffer Hit Mgs for ${outGoingMsg.Symbol} at ${outGoingMsg.tradePrice}.`);
        await channel.close();
    } catch (error)
    {
        console.error('[Producer] Error sending email job:', error);
    } finally
    {
        if (connection) await connection.close();
    }



}
async function sendUserPlanMessage(singleWatch, trade)
{
    let outgoingMessageDetails = {
        userId: singleWatch.userId,
        tickerSymbol: trade.Symbol,
        plannedId: singleWatch.plannedTradeId,
        pricePoints: singleWatch.pricePoints,
        tradePrice: trade.Price,
    }

    try
    {
        if (rabbitConnection && rabbitChannel)
        {
            await rabbitChannel.sendToQueue(rabbitQueueNames.loggedInEnterExitPlanQueue, Buffer.from(JSON.stringify(outgoingMessageDetails)), { persistent: false })
            console.log(`Trade Stream Producer sent enter/exit plan price update for user ${singleWatch.userId}.`)
        } else
        {
            rabbitConnection = await amqp.connect('amqp://localhost')
            rabbitChannel = await connection.createChannel();
            await rabbitChannel.assertQueue(rabbitQueueNames.loggedInEnterExitPlanQueue, { durable: true }); // Durable queue survives broker restarts
            rabbitChannel.sendToQueue(rabbitQueueNames.loggedInEnterExitPlanQueue, Buffer.from(JSON.stringify(outgoingMessageDetails)), { persistent: false });// Persistent messages survive broker restarts
            console.log(`Trade Stream Producer sent enter/exit plan price update for user ${singleWatch.userId}.`)
        }
    } catch (error)
    {
        console.error(`Trade Stream Producer failed to send enter/exit plan price update for ticker ${trade.Symbol} and user: ${singleWatch.userId}.`, error);
    }
}
async function sendUserActiveTradeMessage(singleWatch, trade)
{
    let outgoingMessageDetails = {
        userId: singleWatch.userId,
        tickerSymbol: trade.Symbol,
        plannedId: singleWatch.plannedTradeId,
        pricePoints: singleWatch.pricePoints,
        tradePrice: trade.Price,
    }

    try
    {
        if (rabbitConnection && rabbitChannel)
        {
            await rabbitChannel.sendToQueue(rabbitQueueNames.loggedInActiveTradeQueue, Buffer.from(JSON.stringify(outgoingMessageDetails)), { persistent: false })
            console.log(`Trade Stream Producer sent active trade price update for user ${singleWatch.userId}.`)
        } else
        {
            rabbitConnection = await amqp.connect('amqp://localhost')
            rabbitChannel = await connection.createChannel();
            await rabbitChannel.assertQueue(rabbitQueueNames.loggedInEnterExitPlanQueue, { durable: true }); // Durable queue survives broker restarts
            rabbitChannel.sendToQueue(rabbitQueueNames.loggedInEnterExitPlanQueue, Buffer.from(JSON.stringify(outgoingMessageDetails)), { persistent: false });// Persistent messages survive broker restarts
            console.log(`Trade Stream Producer sent active trade price update for user ${singleWatch.userId}.`)
        }
    } catch (error)
    {
        console.error(`Trade Stream Producer failed to send active trade price update for ticker ${trade.Symbol} and user: ${singleWatch.userId}.`, error);
    }
}







async function trialForTradeRelay(trade, userId)
{
    if (socketConnection)
    {
        socketToFront.emit('tradeStream', { users: ['6952bd331482f8927092ddcc'], trade: { tickerSymbol: "AAT", price: Math.random() * 100 } })
        console.log('Emitting Trade Stream')
    }
}

async function trialActiveTradeMessage(userId)
{
    if (!usersLoggedIn.includes(userId)) return
    let possibleTestTickers = ['AAON', 'AAON', 'AAPL']
    let outgoingMessageDetails = {
        userId: '6952bd331482f8927092ddcc',
        ticker: possibleTestTickers[Math.floor(Math.random() * 2) + 1],
        plannedId: '695eee1fbc2c64a116d5cbd8',
        price: Math.random() * 100,
    }
    try
    {
        if (rabbitConnection && rabbitChannel)
        {
            await rabbitChannel.sendToQueue(rabbitQueueNames.loggedInActiveTradeQueue, Buffer.from(JSON.stringify(outgoingMessageDetails)), { persistent: false })
            //console.log(`Trade Stream Producer sent active trade price update for user ${outgoingMessageDetails.userId}.`)
        } else throw new Error('Rabbit connection does not exist')

    } catch (error)
    {
        console.error(`Trade Stream Producer failed to send enter/exit plan price update for ticker ${trade.Symbol} and user: ${singleWatch.userId} .`, error);
    }

}
async function trialUserPlanMessage(userId)
{
    if (!usersLoggedIn.includes(userId)) return
    let possibleTestTickers = ['AAON', 'AAPL', 'AARD', 'AAUC', 'AAP', 'AAT']
    let outgoingMessageDetails = {
        userId: '6952bd331482f8927092ddcc',
        ticker: possibleTestTickers[Math.floor(Math.random() * 5) + 1],
        plannedId: '695eee1fbc2c64a116d5cbd8',
        //pricePoints: singleWatch.pricePoints,
        price: Math.random() * 100,
    }

    try
    {
        if (rabbitConnection && rabbitChannel)
        {
            await rabbitChannel.sendToQueue(rabbitQueueNames.loggedInEnterExitPlanQueue, Buffer.from(JSON.stringify(outgoingMessageDetails)), { persistent: false })
            //   console.log(`Trade Stream Producer sent enter/exit plan price update for user ${outgoingMessageDetails.userId}.`)
        } else
        {
            rabbitConnection = await amqp.connect('amqp://localhost')
            rabbitChannel = await connection.createChannel();
            await rabbitChannel.assertQueue(rabbitQueueNames.loggedInEnterExitPlanQueue, { durable: true }); // Durable queue survives broker restarts
            rabbitChannel.sendToQueue(rabbitQueueNames.loggedInEnterExitPlanQueue, Buffer.from(JSON.stringify(outgoingMessageDetails)), { persistent: false });// Persistent messages survive broker restarts
            // console.log(`Trade Stream Producer sent enter/exit plan price update for user ${singleWatch.userId}.`)
        }
    } catch (error)
    {
        console.error(`Trade Stream Producer failed to send enter/exit plan price update for ticker ${trade.Symbol} and user: ${singleWatch.userId} .`, error);
    }
}

setInterval(() =>
{
    trialUserPlanMessage('6952bd331482f8927092ddcc')
}, [2000])

setInterval(() =>
{
    trialActiveTradeMessage('6952bd331482f8927092ddcc')
}, [3500])

setInterval(() =>
{
    trialForTradeRelay()
}, [2000])