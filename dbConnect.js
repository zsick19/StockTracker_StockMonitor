const mongoose = require('mongoose')
require('dotenv').config()

const connectDB = async () =>
{
    try
    {
        await mongoose.connect(`${process.env.DATABASE_URI}/StockTraderV3DB`)
        console.log('MongoDB connected Successfully')
    } catch (error)
    {
        console.error('MongoDb Connection Failed:', err.message)
        process.exit(1)
    }
}

module.exports = connectDB