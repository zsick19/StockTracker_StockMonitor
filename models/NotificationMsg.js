const mongoose = require('mongoose')

const notificationMsgSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId },
    Symbol: { type: String },
    trackToTradeId: { type: mongoose.Schema.Types.ObjectId },
    pricePoints: [Number],
    tradeStatus: { type: Number },
    tradePrice: { type: Number },
    dateCreated: { type: Date, default: new Date() }
})

module.exports = mongoose.model('NotificationMsg', notificationMsgSchema)


