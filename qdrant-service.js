const { QdrantClient } = require('@qdrant/js-client-rest');
const { pipeline } = require('@huggingface/transformers');

class QdrantService {
    constructor() {
        this.client = new QdrantClient({
            url: process.env.QDRANT_URL || 'http://localhost:6333',
            apiKey: process.env.QDRANT_API_KEY || undefined
        });
        this.embedder = null;
        this.initialized = false;
        this.collectionName = 'intent_analysis';
    }

    async initialize() {
        if (this.initialized) return;

        try {
            console.log('Loading sentence transformer model...');
            this.embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
            console.log('Model loaded successfully');
            
            await this.ensureCollection();
            this.initialized = true;
            console.log('Qdrant service initialized successfully');
        } catch (error) {
            console.error('Failed to initialize Qdrant service:', error.message);
            this.initialized = false;
            throw error;
        }
    }

    async ensureCollection() {
        try {
            const collections = await this.client.getCollections();
            const exists = collections.collections.some(c => c.name === this.collectionName);

            if (!exists) {
                console.log(`Creating collection: ${this.collectionName}`);
                await this.client.createCollection(this.collectionName, {
                    vectors: { size: 384, distance: 'Cosine' },
                    optimizers_config: { indexing_threshold: 0 }
                });
            } else {
                console.log(`Collection exists: ${this.collectionName}`);
            }
        } catch (error) {
            console.error('Error ensuring collection:', error.message);
            throw error;
        }
    }

    async getEmbedding(text) {
        if (!this.embedder) {
            throw new Error('Embedder not initialized');
        }
        try {
            const output = await this.embedder(text, { pooling: 'mean', normalize: true });
            return Array.from(output.data);
        } catch (error) {
            console.error('Error generating embedding:', error.message);
            throw error;
        }
    }

    async indexDictionaries(dictionaries) {
        console.log('Indexing dictionaries in Qdrant...');
        const points = [];
        let id = 1;

        const addPoints = async (category, entries, isPhrases = false) => {
            for (const [key, value] of Object.entries(entries)) {
                const items = isPhrases ? value : [...value.primary, ...value.synonyms];
                for (const item of items) {
                    const embedding = await this.getEmbedding(item);
                    points.push({
                        id: id++,
                        vector: embedding,
                        payload: {
                            category: category,
                            value: key,
                            text: item,
                            isPrimary: isPhrases ? false : value.primary.includes(item)
                        }
                    });
                }
            }
        };

        await addPoints('intent', dictionaries.intent, false);
        await addPoints('intent', dictionaries.intentPhrases, true);
        await addPoints('action', dictionaries.action, false);
        await addPoints('action', dictionaries.actionPhrases, true);
        await addPoints('process', dictionaries.process, false);
        await addPoints('process', dictionaries.processPhrases, true);
        await addPoints('filter_name', dictionaries.filterName, false);
        await addPoints('filter_name', dictionaries.filterNamePhrases, true);
        await addPoints('filter_operator', dictionaries.filterOperator, false);
        await addPoints('filter_operator', dictionaries.filterOperatorPhrases, true);

        for (const [category, patterns] of Object.entries(dictionaries.filterValue)) {
            const allPatterns = [...patterns.primary, ...patterns.synonyms];
            for (const pattern of allPatterns) {
                const embedding = await this.getEmbedding(pattern);
                points.push({
                    id: id++,
                    vector: embedding,
                    payload: { 
                        category: 'filter_value', value: pattern, text: pattern, 
                        filterCategory: category, isPrimary: patterns.primary.includes(pattern) 
                    }
                });
            }
        }

        for (const [category, phrases] of Object.entries(dictionaries.filterValuePhrases)) {
            for (const phrase of phrases) {
                const embedding = await this.getEmbedding(phrase);
                points.push({
                    id: id++,
                    vector: embedding,
                    payload: { category: 'filter_value', value: phrase, text: phrase, filterCategory: category, isPrimary: false }
                });
            }
        }

        const batchSize = 50;
        for (let i = 0; i < points.length; i += batchSize) {
            const batch = points.slice(i, i + batchSize);
            await this.client.upsert(this.collectionName, { wait: true, points: batch });
            console.log(`Indexed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(points.length / batchSize)}`);
        }

        console.log(`Successfully indexed ${points.length} entries`);
    }

    async searchSimilar(text, category, limit = 10, scoreThreshold = 0.0) {
        if (!this.initialized) {
            throw new Error('Service not initialized');
        }

        try {
            const embedding = await this.getEmbedding(text);
            const searchResult = await this.client.search(this.collectionName, {
                vector: embedding,
                limit: limit,
                filter: { must: [{ key: 'category', match: { value: category } }] },
                with_payload: true
            });

            if (searchResult.length === 0) {
                return { match: null, score: 0, matches: [] };
            }

            const bestMatch = searchResult[0];
            return {
                match: bestMatch.payload.value,
                score: bestMatch.score,
                text: bestMatch.payload.text,
                isPrimary: bestMatch.payload.isPrimary,
                matches: searchResult.map(r => ({ 
                    value: r.payload.value, 
                    score: r.score, 
                    text: r.payload.text 
                }))
            };
        } catch (error) {
            console.error(`Error searching: ${error.message}`);
            return { match: null, score: 0, matches: [] };
        }
    }

    async clearCollection() {
        try {
            await this.client.deleteCollection(this.collectionName);
            console.log(`Deleted collection: ${this.collectionName}`);
            await this.ensureCollection();
            console.log('Collection cleared and recreated');
        } catch (error) {
            console.error('Error clearing collection:', error.message);
        }
    }

    async getCollectionInfo() {
        try {
            const info = await this.client.getCollection(this.collectionName);
            return info;
        } catch (error) {
            console.error('Error getting collection info:', error.message);
            return null;
        }
    }
}

module.exports = new QdrantService();