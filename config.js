//
// config.js
//
// This file centralizes the configuration management for the application.
// It reads environment variables, providing default values for local development
// and ensuring that critical settings are available to all modules.
//

require('dotenv').config();

const config = {
  // LLM API Configuration - Updated to use Anthropic
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,

  // SQLite Database Configuration
  SQLITE_DB_PATH: process.env.SQLITE_DB_PATH || './db.sqlite',

  // Neo4j Database Configuration
  NEO4J_URI: process.env.NEO4J_URI || 'bolt://localhost:7687',
  NEO4J_USER: process.env.NEO4J_USER || 'neo4j',
  NEO4J_PASSWORD: process.env.NEO4J_PASSWORD || 'password',
  NEO4J_DATABASE: process.env.NEO4J_DATABASE || 'neo4j',

  // Agent-specific Configuration
  INGESTOR_BATCH_SIZE: parseInt(process.env.INGESTOR_BATCH_SIZE, 10) || 100,
  INGESTOR_INTERVAL_MS: parseInt(process.env.INGESTOR_INTERVAL_MS, 10) || 10000,

  // Redis Configuration
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,

  // BullMQ Queue Names
  QUEUE_NAMES: [
    'file-analysis-queue',
    'directory-aggregation-queue',
    'directory-resolution-queue',
    'relationship-resolution-queue',
    'reconciliation-queue',
    'failed-jobs',
    'analysis-findings-queue',
    'global-resolution-queue',
    'relationship-validated-queue'
  ],
};

// Dynamically create and export queue name constants
config.QUEUE_NAMES.forEach(queueName => {
    const constantName = queueName.replace(/-/g, '_').toUpperCase() + '_QUEUE_NAME';
    config[constantName] = queueName;
});

// Security Hardening: Check for missing essential configurations
const required_configs = [
    'SQLITE_DB_PATH',
    'NEO4J_URI',
    'NEO4J_USER',
    'NEO4J_PASSWORD',
    'ANTHROPIC_API_KEY',  // Updated from DEEPSEEK_API_KEY
    'REDIS_URL'
];

if (process.env.NODE_ENV === 'production') {
    required_configs.push('REDIS_PASSWORD');
}

const missing_configs = required_configs.filter(key => !config[key]);

if (missing_configs.length > 0) {
    console.error('FATAL ERROR: The following environment variables are not set:');
    missing_configs.forEach(config => console.error(`- ${config}`));
    console.error('Please set them in your .env file before starting.');
    process.exit(1);
}

// Security Hardening: Prevent startup with default password in production
if (process.env.NODE_ENV === 'production' && config.NEO4J_PASSWORD === 'password') {
  console.error('FATAL ERROR: Default Neo4j password is being used in a production environment.');
  console.error('Set the NEO4J_PASSWORD environment variable to a secure password before starting.');
  process.exit(1);
}

module.exports = config;