const { DatabaseManager } = require('./utils/sqliteDb');
const neo4jDriver = require('./utils/neo4jDriver');
const { getInstance: getQueueManagerInstance } = require('./utils/queueManager');
const { getCacheClient, closeCacheClient } = require('./utils/cacheClient');
const EntityScout = require('./agents/EntityScout');
const FileAnalysisWorker = require('./workers/fileAnalysisWorker');
const DirectoryResolutionWorker = require('./workers/directoryResolutionWorker');
const DirectoryAggregationWorker = require('./workers/directoryAggregationWorker');
const RelationshipResolutionWorker = require('./workers/relationshipResolutionWorker');
const ValidationWorker = require('./workers/ValidationWorker');
const ReconciliationWorker = require('./workers/ReconciliationWorker');
const GraphBuilderWorker = require('./agents/GraphBuilder');
const TransactionalOutboxPublisher = require('./services/TransactionalOutboxPublisher');
const config = require('./config');
const { v4: uuidv4 } = require('uuid');
const { getAnthropicClient } = require('./utils/anthropicClient');

class CognitiveTriangulationPipeline {
    constructor(targetDirectory, dbPath = './database.db') {
        this.targetDirectory = targetDirectory;
        this.dbPath = dbPath;
        this.runId = uuidv4();
        this.queueManager = getQueueManagerInstance();
        this.dbManager = new DatabaseManager(this.dbPath);
        this.cacheClient = getCacheClient();
        this.llmClient = getAnthropicClient();
        this.outboxPublisher = new TransactionalOutboxPublisher(this.dbManager, this.queueManager);
        this.metrics = {
            startTime: null,
            endTime: null,
            totalJobs: 0,
        };
    }

    async initialize() {
        console.log('🚀 [main.js] Initializing Cognitive Triangulation v2 Pipeline...');
        await this.queueManager.connect();
        this.dbManager.initializeDb();
        console.log('🚀 [main.js] Database schema initialized.');
        await this.clearDatabases();
        console.log('✅ [main.js] Databases and clients initialized successfully');
    }

    async run() {
        console.log(`🚀 [main.js] Pipeline run started with ID: ${this.runId}`);
        this.metrics.startTime = new Date();
        try {
            await this.initialize();

            console.log('🏁 [main.js] Starting workers and services...');
            this.startWorkers();
            this.outboxPublisher.start();

            console.log('🔍 [main.js] Starting EntityScout to produce jobs...');
            const entityScout = new EntityScout(this.queueManager, this.cacheClient, this.targetDirectory, this.runId);
            const { totalJobs } = await entityScout.run();
            this.metrics.totalJobs = totalJobs;
            console.log(`✅ [main.js] EntityScout created ${totalJobs} initial jobs.`);

            console.log('⏳ [main.js] Waiting for all jobs to complete...');
            await this.waitForCompletion();
            console.log('🎉 [main.js] All analysis and reconciliation jobs completed!');
            
            console.log('🏗️ [main.js] Starting final graph build...');
            const graphBuilder = new GraphBuilderWorker(this.dbManager.getDb(), neo4jDriver);
            await graphBuilder.run();
            console.log('✅ [main.js] Graph build complete.');

            this.metrics.endTime = new Date();
            await this.printFinalReport();
        } catch (error) {
            console.error('❌ [main.js] Critical error in pipeline execution:', error);
            throw error;
        } finally {
            await this.close();
        }
    }

    startWorkers() {
        // Note: In a real distributed system, these would run in separate processes.
        new FileAnalysisWorker(this.queueManager, this.dbManager, this.cacheClient, this.llmClient);
        new DirectoryResolutionWorker(this.queueManager, this.dbManager, this.cacheClient, this.llmClient);
        new DirectoryAggregationWorker(this.queueManager, this.cacheClient);
        new RelationshipResolutionWorker(this.queueManager, this.dbManager, this.llmClient);
        new ValidationWorker(this.queueManager, this.dbManager, this.cacheClient);
        new ReconciliationWorker(this.queueManager, this.dbManager);
        console.log('✅ All workers are running and listening for jobs.');
    }

    async clearDatabases() {
        const db = this.dbManager.getDb();
        console.log('🗑️ Clearing SQLite database...');
        db.exec('DELETE FROM relationships');
        db.exec('DELETE FROM relationship_evidence');
        db.exec('DELETE FROM pois');
        db.exec('DELETE FROM files');
        db.exec('DELETE FROM directory_summaries');

        console.log('🗑️ Clearing Redis database...');
        await this.cacheClient.flushdb();

        const driver = neo4jDriver;
        console.log('🗑️ Clearing Neo4j database...');
        const session = driver.session({ database: config.NEO4J_DATABASE });
        try {
            await session.run('MATCH (n) DETACH DELETE n');
            console.log('✅ Neo4j database cleared successfully');
        } catch (error) {
            console.error('❌ Error clearing Neo4j database:', error);
            throw error;
        } finally {
            await session.close();
        }
    }

    async printFinalReport() {
        const duration = this.metrics.endTime - this.metrics.startTime;
        const durationSeconds = Math.round(duration / 1000);
        
        console.log(`\n🎯 ====== Cognitive Triangulation v2 Report ======`);
        console.log(`Run ID: ${this.runId}`);
        console.log(`⏱️  Total Duration: ${durationSeconds} seconds`);
        console.log(`📈 Total Initial Jobs: ${this.metrics.totalJobs}`);
        console.log(`==============================================\n`);
    }

    async waitForCompletion() {
        return new Promise((resolve, reject) => {
            const checkInterval = 5000; // Check every 5 seconds
            let idleChecks = 0;
            const requiredIdleChecks = 3; // Require 3 consecutive idle checks to be sure

            const intervalId = setInterval(async () => {
                try {
                    const counts = await this.queueManager.getJobCounts();
                    const totalActive = counts.active + counts.waiting + counts.delayed;
                    
                    console.log(`[Queue Monitor] Active: ${counts.active}, Waiting: ${counts.waiting}, Completed: ${counts.completed}, Failed: ${counts.failed}`);

                    if (totalActive === 0) {
                        idleChecks++;
                        console.log(`[Queue Monitor] Queues appear idle. Check ${idleChecks}/${requiredIdleChecks}.`);
                        if (idleChecks >= requiredIdleChecks) {
                            clearInterval(intervalId);
                            resolve();
                        }
                    } else {
                        idleChecks = 0; // Reset if we see activity
                    }
                } catch (error) {
                    clearInterval(intervalId);
                    reject(error);
                }
            }, checkInterval);
        });
    }

    async close() {
        console.log('🚀 [main.js] Closing connections...');
        this.outboxPublisher.stop();
        await this.queueManager.closeConnections();
        await closeCacheClient();
        const driver = neo4jDriver;
        if (process.env.NODE_ENV !== 'test' && driver) {
            await driver.close();
        }
        this.dbManager.close();
        console.log('✅ [main.js] Connections closed.');
    }
}

async function main() {
    const args = process.argv.slice(2);
    const targetDirectory = args.includes('--target') ? args[args.indexOf('--target') + 1] : process.cwd();
    const isTestMode = args.includes('--test-mode');
    let pipeline;

    try {
        pipeline = new CognitiveTriangulationPipeline(targetDirectory);
        await pipeline.run();
        console.log('🎉 Cognitive triangulation pipeline completed successfully!');
        if (isTestMode) {
            // In test mode, we exit cleanly for the test runner.
            process.exit(0);
        }
    } catch (error) {
        console.error('💥 Fatal error in pipeline:', error);
        if (pipeline) {
            await pipeline.close();
        }
        process.exit(1);
    }
}

// Only run main if this file is executed directly
if (require.main === module) {
    main();
}

module.exports = { CognitiveTriangulationPipeline, main };