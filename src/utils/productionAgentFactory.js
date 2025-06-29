const path = require('path');
const { DatabaseManager } = require('../utils/sqliteDb');
const neo4jDriver = require('../utils/neo4jDriver');
const { getInstance: getQueueManagerInstance } = require('../utils/queueManager');
const { getCacheClient } = require('../utils/cacheClient');
const { getAnthropicClient } = require('../utils/anthropicClient');
const config = require('../config');

/**
 * Production Agent Factory
 * 
 * This factory creates and manages the various agents and workers
 * needed for the cognitive triangulation pipeline in production mode.
 * Updated to work with the actual existing agent constructors.
 */
class ProductionAgentFactory {
    constructor() {
        this.agents = new Map();
        this.workers = new Map();
        this.dbManager = null;
        this.queueManager = null;
        this.cacheClient = null;
        this.llmClient = null;
        this.neo4jDriver = null;
    }

    /**
     * Initialize shared dependencies
     */
    async initialize() {
        console.log('🔧 [ProductionAgentFactory] Initializing shared dependencies...');
        
        // Initialize database
        const dbPath = config.SQLITE_DB_PATH || './database.db';
        this.dbManager = new DatabaseManager(dbPath);
        this.dbManager.initializeDb();
        
        // Initialize queue manager and cache
        this.queueManager = getQueueManagerInstance();
        await this.queueManager.connect();
        this.cacheClient = getCacheClient();
        
        // Initialize LLM client
        this.llmClient = getAnthropicClient();
        
        // Initialize Neo4j driver
        this.neo4jDriver = neo4jDriver;
        
        console.log('✅ [ProductionAgentFactory] Dependencies initialized');
    }

    /**
     * Create and initialize all pipeline agents
     */
    async createAgents(targetDirectory, pipelineId) {
        try {
            console.log(`🏭 [ProductionAgentFactory] Creating agents for pipeline: ${pipelineId}`);
            
            if (!this.dbManager) {
                await this.initialize();
            }
            
            // Create EntityScout with actual constructor signature
            const EntityScout = require('../agents/EntityScout');
            const entityScout = new EntityScout(
                this.queueManager, 
                this.cacheClient, 
                targetDirectory, 
                pipelineId
            );
            this.agents.set('entityScout', entityScout);
            
            // Create RelationshipResolver with actual constructor signature
            const RelationshipResolver = require('../agents/RelationshipResolver');
            const relationshipResolver = new RelationshipResolver(
                this.dbManager.getDb(), 
                config.ANTHROPIC_API_KEY
            );
            this.agents.set('relationshipResolver', relationshipResolver);
            
            // Create GraphBuilder with actual constructor signature
            const GraphBuilder = require('../agents/GraphBuilder');
            const graphBuilder = new GraphBuilder(
                this.dbManager.getDb(), 
                this.neo4jDriver, 
                config.NEO4J_DATABASE
            );
            this.agents.set('graphBuilder', graphBuilder);
            
            // Create SelfCleaningAgent with actual constructor signature
            try {
                const SelfCleaningAgent = require('../agents/SelfCleaningAgent');
                const selfCleaningAgent = new SelfCleaningAgent(
                    this.dbManager.getDb(),
                    this.neo4jDriver,
                    targetDirectory
                );
                this.agents.set('selfCleaningAgent', selfCleaningAgent);
            } catch (error) {
                console.warn('⚠️ SelfCleaningAgent not available:', error.message);
            }
            
            console.log(`✅ [ProductionAgentFactory] Created ${this.agents.size} agents`);
            return this.agents;
            
        } catch (error) {
            console.error('❌ [ProductionAgentFactory] Failed to create agents:', error.message);
            throw error;
        }
    }

    /**
     * Create and initialize all pipeline workers
     */
    async createWorkers(pipelineId) {
        try {
            console.log(`👷 [ProductionAgentFactory] Creating workers for pipeline: ${pipelineId}`);
            
            if (!this.dbManager) {
                await this.initialize();
            }
            
            // Create workers using actual constructors from the existing files
            const workers = [
                { name: 'FileAnalysisWorker', path: '../workers/fileAnalysisWorker' },
                { name: 'DirectoryAggregationWorker', path: '../workers/directoryAggregationWorker' },
                { name: 'DirectoryResolutionWorker', path: '../workers/directoryResolutionWorker' },
                { name: 'RelationshipResolutionWorker', path: '../workers/relationshipResolutionWorker' },
                { name: 'ValidationWorker', path: '../workers/ValidationWorker' },
                { name: 'ReconciliationWorker', path: '../workers/ReconciliationWorker' }
            ];

            for (const workerInfo of workers) {
                try {
                    const WorkerClass = require(workerInfo.path);
                    let worker;
                    
                    // Use actual constructor signatures from existing workers
                    switch (workerInfo.name) {
                        case 'FileAnalysisWorker':
                            worker = new WorkerClass(this.queueManager, this.dbManager, this.cacheClient, this.llmClient);
                            break;
                        case 'DirectoryAggregationWorker':
                            worker = new WorkerClass(this.queueManager, this.cacheClient);
                            break;
                        case 'DirectoryResolutionWorker':
                            worker = new WorkerClass(this.queueManager, this.dbManager, this.cacheClient, this.llmClient);
                            break;
                        case 'RelationshipResolutionWorker':
                            worker = new WorkerClass(this.queueManager, this.dbManager, this.llmClient);
                            break;
                        case 'ValidationWorker':
                            worker = new WorkerClass(this.queueManager, this.dbManager, this.cacheClient);
                            break;
                        case 'ReconciliationWorker':
                            worker = new WorkerClass(this.queueManager, this.dbManager);
                            break;
                        default:
                            console.warn(`Unknown worker type: ${workerInfo.name}`);
                            continue;
                    }
                    
                    this.workers.set(workerInfo.name.toLowerCase(), worker);
                } catch (error) {
                    console.warn(`⚠️ Worker ${workerInfo.name} not available:`, error.message);
                }
            }
            
            console.log(`✅ [ProductionAgentFactory] Created ${this.workers.size} workers`);
            return this.workers;
            
        } catch (error) {
            console.error('❌ [ProductionAgentFactory] Failed to create workers:', error.message);
            throw error;
        }
    }

    /**
     * Start the pipeline execution
     */
    async startPipeline(targetDirectory, pipelineId) {
        try {
            console.log(`🚀 [ProductionAgentFactory] Starting pipeline: ${pipelineId}`);
            
            // Initialize if not already done
            if (!this.dbManager) {
                await this.initialize();
            }
            
            // Create agents and workers
            await this.createAgents(targetDirectory, pipelineId);
            await this.createWorkers(pipelineId);
            
            // Start the TransactionalOutboxPublisher
            try {
                const TransactionalOutboxPublisher = require('../services/TransactionalOutboxPublisher');
                const outboxPublisher = new TransactionalOutboxPublisher(this.dbManager, this.queueManager);
                outboxPublisher.start();
                console.log('✅ TransactionalOutboxPublisher started');
            } catch (error) {
                console.warn('⚠️ TransactionalOutboxPublisher not available:', error.message);
            }
            
            // Start the discovery process
            const entityScout = this.agents.get('entityScout');
            if (!entityScout) {
                throw new Error('EntityScout agent not available');
            }
            
            console.log(`🔍 [ProductionAgentFactory] Starting file discovery for: ${targetDirectory}`);
            await entityScout.run();
            
            return {
                status: 'started',
                pipelineId: pipelineId,
                targetDirectory: targetDirectory,
                agents: Array.from(this.agents.keys()),
                workers: Array.from(this.workers.keys())
            };
            
        } catch (error) {
            console.error('❌ [ProductionAgentFactory] Failed to start pipeline:', error.message);
            throw error;
        }
    }

    /**
     * Methods called by pipelineApi.js
     */
    async clearAllDatabases() {
        if (!this.dbManager) {
            await this.initialize();
        }
        
        console.log('🗑️ Clearing SQLite database...');
        const db = this.dbManager.getDb();
        db.exec('DELETE FROM relationships');
        db.exec('DELETE FROM relationship_evidence');
        db.exec('DELETE FROM pois');
        db.exec('DELETE FROM files');
        db.exec('DELETE FROM directory_summaries');
        db.exec('DELETE FROM outbox');

        console.log('🗑️ Clearing Redis database...');
        await this.cacheClient.flushdb();

        console.log('🗑️ Clearing Neo4j database...');
        const session = this.neo4jDriver.session({ database: config.NEO4J_DATABASE });
        try {
            await session.run('MATCH (n) DETACH DELETE n');
            console.log('✅ Neo4j database cleared successfully');
        } finally {
            await session.close();
        }
    }

    async testConnections() {
        if (!this.dbManager) {
            await this.initialize();
        }
        
        const results = {
            sqlite: false,
            anthropic: false,
            neo4j: false,
            redis: false
        };
        
        try {
            // Test SQLite
            this.dbManager.getDb().prepare('SELECT 1').get();
            results.sqlite = true;
            console.log('✅ SQLite connection verified');
        } catch (error) {
            console.error('❌ SQLite connection failed:', error.message);
        }
        
        try {
            // Test Anthropic
            results.anthropic = await this.llmClient.testConnection();
            console.log('✅ Anthropic connection verified');
        } catch (error) {
            console.error('❌ Anthropic connection failed:', error.message);
        }
        
        try {
            // Test Neo4j
            await this.neo4jDriver.verifyConnectivity();
            results.neo4j = true;
            console.log('✅ Neo4j connection verified');
        } catch (error) {
            console.error('❌ Neo4j connection failed:', error.message);
        }
        
        try {
            // Test Redis
            await this.cacheClient.ping();
            results.redis = true;
            console.log('✅ Redis connection verified');
        } catch (error) {
            console.error('❌ Redis connection failed:', error.message);
        }
        
        return results;
    }

    async createEntityScout(targetDirectory) {
        const entityScout = this.agents.get('entityScout');
        if (!entityScout) {
            throw new Error('EntityScout not initialized');
        }
        return entityScout;
    }

    async createGraphBuilder() {
        const graphBuilder = this.agents.get('graphBuilder');
        if (!graphBuilder) {
            throw new Error('GraphBuilder not initialized');
        }
        return graphBuilder;
    }

    async createRelationshipResolver() {
        const relationshipResolver = this.agents.get('relationshipResolver');
        if (!relationshipResolver) {
            throw new Error('RelationshipResolver not initialized');
        }
        return relationshipResolver;
    }

    async getSqliteConnection() {
        return this.dbManager.getDb();
    }

    /**
     * Stop the pipeline and cleanup resources
     */
    async stopPipeline(pipelineId) {
        try {
            console.log(`🛑 [ProductionAgentFactory] Stopping pipeline: ${pipelineId}`);
            
            // Stop all workers
            for (const [name, worker] of this.workers) {
                try {
                    if (worker.close && typeof worker.close === 'function') {
                        await worker.close();
                        console.log(`✅ Stopped worker: ${name}`);
                    }
                } catch (error) {
                    console.warn(`⚠️ Error stopping worker ${name}:`, error.message);
                }
            }
            
            // Stop all agents (most agents don't have stop methods, but check anyway)
            for (const [name, agent] of this.agents) {
                try {
                    if (agent.stop && typeof agent.stop === 'function') {
                        await agent.stop();
                        console.log(`✅ Stopped agent: ${name}`);
                    }
                } catch (error) {
                    console.warn(`⚠️ Error stopping agent ${name}:`, error.message);
                }
            }
            
            console.log(`✅ [ProductionAgentFactory] Pipeline stopped: ${pipelineId}`);
            
        } catch (error) {
            console.error('❌ [ProductionAgentFactory] Error stopping pipeline:', error.message);
            throw error;
        }
    }

    /**
     * Cleanup all resources
     */
    async cleanup() {
        try {
            console.log('🧹 [ProductionAgentFactory] Cleaning up resources...');
            
            // Close queue manager connections
            if (this.queueManager) {
                await this.queueManager.closeConnections();
            }
            
            // Close cache client
            if (this.cacheClient) {
                const { closeCacheClient } = require('../utils/cacheClient');
                await closeCacheClient();
            }
            
            // Close Neo4j driver
            if (this.neo4jDriver && this.neo4jDriver.close) {
                await this.neo4jDriver.close();
            }
            
            // Close database manager
            if (this.dbManager) {
                this.dbManager.close();
            }
            
            // Clear collections
            this.agents.clear();
            this.workers.clear();
            
            console.log('✅ [ProductionAgentFactory] Cleanup complete');
            
        } catch (error) {
            console.error('❌ [ProductionAgentFactory] Error during cleanup:', error.message);
            throw error;
        }
    }

    /**
     * Get the status of all agents and workers
     */
    getStatus() {
        return {
            agents: {
                count: this.agents.size,
                list: Array.from(this.agents.keys())
            },
            workers: {
                count: this.workers.size,
                list: Array.from(this.workers.keys())
            }
        };
    }
}

module.exports = ProductionAgentFactory;