const { QdrantClient } = require('@qdrant/js-client-rest');
const { pipeline } = require('@huggingface/transformers');

class QdrantService {
  constructor() {
    this.client = new QdrantClient({
      url: process.env.QDRANT_URL || 'http://localhost:6333',
      apiKey: process.env.QDRANT_API_KEY || undefined,
      timeout: 30000 // 30 second timeout
    });
    this.embedder = null;
    this.initialized = false;
    this.collectionName = 'intent_analysis';
    this.nextId = 10000; // Start IDs from 10000 for dynamically added phrases
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
    const maxRetries = 3;
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
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
        return; // Success!
        
      } catch (error) {
        lastError = error;
        console.error(`❌ Attempt ${attempt}/${maxRetries} failed:`, error.message);
        
        if (attempt < maxRetries) {
          const delay = attempt * 2000; // Exponential backoff: 2s, 4s, 6s
          console.log(`⏳ Retrying in ${delay/1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError || new Error('Failed to ensure collection after retries');
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
            category: 'filter_value', 
            value: pattern, 
            text: pattern,
            filterCategory: category, 
            isPrimary: patterns.primary.includes(pattern)
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
          payload: { 
            category: 'filter_value', 
            value: phrase, 
            text: phrase, 
            filterCategory: category, 
            isPrimary: false 
          }
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
    this.nextId = id; // Update next available ID
  }

  // Add a single phrase to Qdrant
  async addPhrase(phrase, category, standardForm) {
    if (!this.initialized) {
      console.error('⚠️ Qdrant service not initialized');
      return false;
    }

    try {
      console.log(`[QDRANT] Adding phrase "${phrase}" to category "${category}" with standard form "${standardForm}"`);
      
      const embedding = await this.getEmbedding(phrase);
      
      await this.client.upsert(this.collectionName, {
        wait: true,
        points: [{
          id: this.nextId++,
          vector: embedding,
          payload: {
            category: category,
            value: standardForm,
            text: phrase,
            isPrimary: false,
            dynamicallyAdded: true,
            addedAt: new Date().toISOString()
          }
        }]
      });
      
      console.log(`[QDRANT] ✓ Successfully added phrase "${phrase}" with ID ${this.nextId - 1}`);
      return true;
    } catch (error) {
      console.error(`[QDRANT] ❌ Error adding phrase "${phrase}":`, error.message);
      return false;
    }
  }

  // Check if a phrase exists in Qdrant
  async phraseExists(phrase, category) {
    if (!this.initialized) {
      return false;
    }

    try {
      const embedding = await this.getEmbedding(phrase);
      const searchResult = await this.client.search(this.collectionName, {
        vector: embedding,
        limit: 10,
        filter: { must: [{ key: 'category', match: { value: category } }] },
        with_payload: true,
        score_threshold: 0.99 // Very high threshold for exact match
      });

      // Check if any result matches the phrase exactly
      return searchResult.some(r => 
        r.payload.text.toLowerCase() === phrase.toLowerCase() ||
        r.payload.value.toLowerCase() === phrase.toLowerCase()
      );
    } catch (error) {
      console.error(`Error checking if phrase exists:`, error.message);
      return false;
    }
  }

  // Improved searchSimilar with better response format
  async searchSimilar(text, category, limit = 10, scoreThreshold = 0.0) {
    if (!this.initialized) {
      console.error('⚠️ Qdrant service not initialized');
      return { match: null, score: 0, all_results: [] };
    }

    const maxRetries = 2;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const embedding = await this.getEmbedding(text);
        const searchResult = await this.client.search(this.collectionName, {
          vector: embedding,
          limit: limit,
          filter: { must: [{ key: 'category', match: { value: category } }] },
          with_payload: true
        });

        if (searchResult.length === 0) {
          return { match: null, score: 0, all_results: [] };
        }

        const bestMatch = searchResult[0];
        
        // Format all results
        const allResults = searchResult.map(r => ({
          match: r.payload.value,
          score: r.score,
          text: r.payload.text,
          isPrimary: r.payload.isPrimary
        }));

        return {
          match: bestMatch.payload.value,
          score: bestMatch.score,
          text: bestMatch.payload.text,
          isPrimary: bestMatch.payload.isPrimary,
          all_results: allResults
        };

      } catch (error) {
        lastError = error;
        console.error(`❌ Qdrant search attempt ${attempt}/${maxRetries} failed:`, error.message);
        
        // Check if it's a specific error type
        if (error.message.includes('Service Unavailable') || 
            error.message.includes('503') ||
            error.message.includes('ECONNREFUSED') ||
            error.message.includes('timeout')) {
          
          if (attempt < maxRetries) {
            console.log(`⏳ Retrying in 2 seconds...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
          }
        } else {
          // For other errors, don't retry
          break;
        }
      }
    }

    // All retries failed - return empty result gracefully
    console.error('⚠️ All Qdrant retries failed, falling back to programmatic matching');
    return { match: null, score: 0, all_results: [] };
  }

  // Get all points from a category (for debugging)
  async getAllPoints(category, limit = 100) {
    if (!this.initialized) {
      console.error('⚠️ Qdrant service not initialized');
      return [];
    }

    try {
      const response = await this.client.scroll(this.collectionName, {
        filter: {
          must: [
            {
              key: 'category',
              match: { value: category }
            }
          ]
        },
        limit: limit,
        with_payload: true,
        with_vector: false
      });
      
      return response.points.map(point => ({
        id: point.id,
        category: point.payload.category,
        value: point.payload.value,
        text: point.payload.text,
        isPrimary: point.payload.isPrimary,
        dynamicallyAdded: point.payload.dynamicallyAdded || false
      }));
    } catch (error) {
      console.error('Error getting all points:', error);
      return [];
    }
  }

  async clearCollection() {
    try {
      await this.client.deleteCollection(this.collectionName);
      console.log(`Deleted collection: ${this.collectionName}`);
      await this.ensureCollection();
      console.log('Collection cleared and recreated');
      this.nextId = 1; // Reset ID counter
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