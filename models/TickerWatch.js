const mongoose = require('mongoose')

const watchSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId },
        plannedTradeId: { type: mongoose.Schema.Types.ObjectId },
        pricePoints: [Number],
        purpose: Number,
        tradeStatus: Number
    }, { _id: false })

const tickerWatchSchema = new mongoose.Schema({
    _id: { type: String, require: true },
    watchInfo: [watchSchema],
    tradeWatchLevel: { type: Boolean, default: false }
})

module.exports = mongoose.model('TickerWatch', tickerWatchSchema)