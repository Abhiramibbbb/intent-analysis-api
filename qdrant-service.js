const { QdrantClient } = require('@qdrant/js-client-rest');
const { pipeline } = require('@xenova/transformers');

// Initialize Qdrant client with API key support for cloud deployment
const client = new QdrantClient({
    url: process.env.QDRANT_URL || 'http://localhost:6333',
    apiKey: process.env.QDRANT_API_KEY || undefined
});

const COLLECTION_NAME = 'intent_analysis';
const VECTOR_SIZE = 384; // all-MiniLM-L6-v2 embedding size

let model = null;

async function loadModel() {
    if (!model) {
        console.log('Loading sentence transformer model...');
        model = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        console.log('Model loaded successfully');
    }
    return model;
}

async function getEmbedding(text) {
    const model = await loadModel();
    const output = await model(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

async function initialize() {
    try {
        console.log('Qdrant service initialized successfully');
        await loadModel();
        await ensureCollection();
    } catch (error) {
        console.error('Failed to initialize Qdrant service:', error);
        throw error;
    }
}

async function ensureCollection() {
    try {
        const collections = await client.getCollections();
        const exists = collections.collections.some(col => col.name === COLLECTION_NAME);
        
        if (!exists) {
            console.log(`Creating collection: ${COLLECTION_NAME}`);
            await client.createCollection(COLLECTION_NAME, {
                vectors: {
                    size: VECTOR_SIZE,
                    distance: 'Cosine'
                }
            });
            console.log(`Created collection: ${COLLECTION_NAME}`);
        }
    } catch (error) {
        console.error('Error ensuring collection:', error);
        throw error;
    }
}

async function indexDictionaries(dictionaries) {
    try {
        console.log('Indexing dictionaries in Qdrant...');
        
        const points = [];
        let id = 1;
        
        // Helper to create points from dictionary
        const addPoints = (dict, category, isPhrases = false) => {
            for (const [key, data] of Object.entries(dict)) {
                if (isPhrases) {
                    // For phrase dictionaries
                    for (const phrase of data) {
                        points.push({
                            text: phrase,
                            category: category,
                            value: key
                        });
                    }
                } else {
                    // For regular dictionaries with primary and synonyms
                    for (const word of [...data.primary, ...data.synonyms]) {
                        points.push({
                            text: word,
                            category: category,
                            value: key
                        });
                    }
                }
            }
        };
        
        // Index all dictionaries
        addPoints(dictionaries.intent, 'intent');
        addPoints(dictionaries.intentPhrases, 'intent', true);
        addPoints(dictionaries.action, 'action');
        addPoints(dictionaries.actionPhrases, 'action', true);
        addPoints(dictionaries.process, 'process');
        addPoints(dictionaries.processPhrases, 'process', true);
        addPoints(dictionaries.filterName, 'filter_name');
        addPoints(dictionaries.filterNamePhrases, 'filter_name', true);
        addPoints(dictionaries.filterOperator, 'filter_operator');
        addPoints(dictionaries.filterOperatorPhrases, 'filter_operator', true);
        addPoints(dictionaries.filterValue, 'filter_value');
        addPoints(dictionaries.filterValuePhrases, 'filter_value', true);
        
        // Create embeddings and upload in batches
        const batchSize = 50;
        for (let i = 0; i < points.length; i += batchSize) {
            const batch = points.slice(i, i + batchSize);
            const qdrantPoints = [];
            
            for (const point of batch) {
                const embedding = await getEmbedding(point.text);
                qdrantPoints.push({
                    id: id++,
                    vector: embedding,
                    payload: {
                        text: point.text,
                        category: point.category,
                        value: point.value
                    }
                });
            }
            
            await client.upsert(COLLECTION_NAME, {
                wait: true,
                points: qdrantPoints
            });
            
            console.log(`Indexed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(points.length / batchSize)}`);
        }
        
        console.log(`Successfully indexed ${points.length} entries in Qdrant`);
    } catch (error) {
        console.error('Error indexing dictionaries:', error);
        throw error;
    }
}

async function searchSimilar(text, category, limit = 10, threshold = 0.7) {
    try {
        const embedding = await getEmbedding(text);
        
        const searchResult = await client.search(COLLECTION_NAME, {
            vector: embedding,
            filter: {
                must: [
                    {
                        key: 'category',
                        match: { value: category }
                    }
                ]
            },
            limit: limit,
            with_payload: true
        });
        
        if (searchResult.length > 0) {
            const topResult = searchResult[0];
            return {
                match: topResult.payload.value,
                score: topResult.score,
                text: topResult.payload.text
            };
        }
        
        return { match: null, score: 0, text: null };
    } catch (error) {
        console.error('Error searching in Qdrant:', error);
        return { match: null, score: 0, text: null };
    }
}

async function getCollectionInfo() {
    try {
        return await client.getCollection(COLLECTION_NAME);
    } catch (error) {
        console.error('Error getting collection info:', error);
        return null;
    }
}

module.exports = {
    client,
    initialize,
    indexDictionaries,
    searchSimilar,
    getCollectionInfo
};
