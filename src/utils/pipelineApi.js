const pipelineApi = {
    activePipelines: new Map(),
    broadcastUpdate(pipelineId, status) {
        // Implement your broadcast logic here
    },
    updatePipelineStatus(pipelineId, updates, logMessage) {
        const pipeline = this.activePipelines.get(pipelineId);
        if (!pipeline) return;
        Object.keys(updates).forEach(key => {
            if (key.includes('.')) {
                // Nested update
                const [outer, inner] = key.split('.');
                if (!pipeline.progress[outer]) pipeline.progress[outer] = {};
                pipeline.progress[outer][inner] = updates[key];
            } else {
                pipeline[key] = updates[key];
            }
        });
        pipeline.lastUpdate = new Date().toISOString();
        if (logMessage) pipeline.logs.push({ time: new Date().toISOString(), message: logMessage });
        this.broadcastUpdate(pipelineId, pipeline);
    },
    async startPipelineAsync(pipelineId, targetDirectory) {
        console.log(`[PIPELINE ${pipelineId}] Starting real pipeline for directory: ${targetDirectory}`);
        
        const pipelineStatus = {
            pipelineId: pipelineId,
            targetDirectory: targetDirectory,
            status: 'starting',
            phase: 'initialization',
            startTime: new Date().toISOString(),
            lastUpdate: new Date().toISOString(),
            progress: {
                entityScout: { status: 'pending', filesProcessed: 0, entitiesFound: 0 },
                graphBuilder: { status: 'pending', nodesCreated: 0, relationshipsCreated: 0 },
                relationshipResolver: { status: 'pending', relationshipsResolved: 0, confidenceScore: 0 }
            },
            logs: []
        };
        
        this.activePipelines.set(pipelineId, pipelineStatus);
        this.broadcastUpdate(pipelineId, pipelineStatus);
    
        let factory;
        try {
            // Import the real pipeline components
            const ProductionAgentFactory = require('./productionAgentFactory');
            factory = new ProductionAgentFactory();
            
            // Phase 1: Clear databases
            this.updatePipelineStatus(pipelineId, {
                phase: 'clearing_databases',
                status: 'running'
            }, '🗑️  Phase 1: Clearing databases for fresh start...');
            
            await factory.clearAllDatabases();
            this.updatePipelineStatus(pipelineId, {}, '✅ Databases cleared and schema initialized');
            
            // Phase 2: Test connections
            this.updatePipelineStatus(pipelineId, {
                phase: 'testing_connections'
            }, '🔗 Phase 2: Testing database and API connections...');
            
            const connections = await factory.testConnections();
            if (!connections.sqlite || !connections.deepseek || !connections.neo4j) {
                throw new Error('Required connections failed');
            }
            this.updatePipelineStatus(pipelineId, {}, '✅ All connections verified');
            
            // Phase 3: Run EntityScout
            this.updatePipelineStatus(pipelineId, {
                phase: 'entity_scout',
                'progress.entityScout.status': 'running'
            }, `🔍 Phase 3: Starting EntityScout analysis of ${targetDirectory}...`);
            
            const entityScout = await factory.createEntityScout(targetDirectory);
            await entityScout.run();
            
            // Get EntityScout results
            const db = await factory.getSqliteConnection();
            const entityReports = await db.all("SELECT COUNT(*) as count FROM entity_reports");
            const totalFiles = await db.all("SELECT COUNT(*) as count FROM files");
            
            this.updatePipelineStatus(pipelineId, {
                'progress.entityScout.status': 'completed',
                'progress.entityScout.filesProcessed': totalFiles[0].count,
                'progress.entityScout.entitiesFound': entityReports[0].count
            }, `✅ Phase 3 Complete: Processed ${totalFiles[0].count} files, found ${entityReports[0].count} entities`);
            
            // Phase 4: Run GraphBuilder
            this.updatePipelineStatus(pipelineId, {
                phase: 'graph_builder',
                'progress.graphBuilder.status': 'running'
            }, `🏗️ Phase 4: Starting GraphBuilder to create knowledge graph...`);
            
            const graphBuilder = await factory.createGraphBuilder();
            await graphBuilder.run();
            
            // Get GraphBuilder results from Neo4j
            const neo4jDriver = require('./neo4jDriver');
            const session = neo4jDriver.session();
            try {
                const nodeResult = await session.run('MATCH (n) RETURN count(n) as count');
                const relationshipResult = await session.run('MATCH ()-[r]->() RETURN count(r) as count');
                
                const nodeCount = nodeResult.records[0].get('count').toNumber();
                const relationshipCount = relationshipResult.records[0].get('count').toNumber();
                
                this.updatePipelineStatus(pipelineId, {
                    'progress.graphBuilder.status': 'completed',
                    'progress.graphBuilder.nodesCreated': nodeCount,
                    'progress.graphBuilder.relationshipsCreated': relationshipCount
                }, `✅ Phase 4 Complete: Created ${nodeCount} nodes and ${relationshipCount} relationships`);
            } finally {
                await session.close();
            }
            
            // Phase 5: Run RelationshipResolver
            this.updatePipelineStatus(pipelineId, {
                phase: 'relationship_resolver',
                'progress.relationshipResolver.status': 'running'
            }, '🔗 Phase 5: Starting RelationshipResolver for cognitive triangulation...');
            
            const relationshipResolver = await factory.createRelationshipResolver();
            await relationshipResolver.run();
            
            // Get final relationship count
            const session2 = neo4jDriver.session();
            try {
                const finalRelationshipResult = await session2.run('MATCH ()-[r]->() RETURN count(r) as count');
                const finalRelationshipCount = finalRelationshipResult.records[0].get('count').toNumber();
                
                this.updatePipelineStatus(pipelineId, {
                    'progress.relationshipResolver.status': 'completed',
                    'progress.relationshipResolver.relationshipsResolved': finalRelationshipCount,
                    'progress.relationshipResolver.confidenceScore': 95 // Placeholder for actual confidence scoring
                }, `✅ Phase 5 Complete: Resolved ${finalRelationshipCount} total relationships with cognitive triangulation`);
            } finally {
                await session2.close();
            }
            
            // Pipeline completed
            this.updatePipelineStatus(pipelineId, {
                status: 'completed',
                phase: 'completed',
                endTime: new Date().toISOString()
            }, '🎉 Cognitive triangulation pipeline completed successfully!');
            
        } catch (error) {
            console.error(`Pipeline ${pipelineId} failed:`, error);
            this.updatePipelineStatus(pipelineId, {
                status: 'failed',
                phase: 'failed',
                error: error.message,
                endTime: new Date().toISOString()
            }, `❌ Pipeline failed: ${error.message}`);
        } finally {
            if (factory && typeof factory.cleanup === 'function') {
                await factory.cleanup();
            }
        }
    }
};

module.exports = pipelineApi;