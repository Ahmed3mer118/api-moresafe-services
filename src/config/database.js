import mongoose from 'mongoose';

export const connectDB = async () => {
  try {
    const connectionString = process.env.MONGODB_URI;
    console.log(connectionString)
    const connection = await mongoose.connect(connectionString);

    console.log(`MongoDB Connected: ${connection.connection.host}`);
  } catch (err) {
    console.log(`Database connection error: ${err.message}`);
    // console.error(err);
    process.exit(1);
  }
};