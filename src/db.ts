import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';

dotenv.config();

const sequelize = new Sequelize(
  process.env.DB_NAME as string,
  process.env.DB_USER as string,
  process.env.DB_PASSWORD as string,
  {
    host: process.env.DB_HOST,
    dialect: 'mysql',
    logging: false,
  }
);

export const connectDB = async () => {
  try {
    await sequelize.authenticate();
    console.log('Connected to MySQL database via Sequelize');
    // Use sync() without alter:true — payment_transactions is a shared table
    // already created and indexed by bloomzon-flutterwave / Bloomzon-Server.
    // alter:true would try to ADD UNIQUE indexes that already exist, hitting
    // MySQL's 64-key limit and crashing on startup.
    await sequelize.sync();
  } catch (error) {
    console.error('Unable to connect to the database:', error);
  }
};

export default sequelize;
