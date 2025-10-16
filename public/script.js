const sentenceInput = document.getElementById('sentenceInput');
const charCount = document.getElementById('charCount');
const analyzeBtn = document.getElementById('analyzeBtn');
const proceedBtn = document.getElementById('proceedBtn');
const clearBtn = document.getElementById('clearBtn');
const analysisResult = document.getElementById('analysisResult');
const refreshBtn = document.getElementById('refreshBtn');
const logsTableBody = document.getElementById('logsTableBody');

// Character counter
sentenceInput.addEventListener('input', () => {
  charCount.textContent = sentenceInput.value.length;
});

// Analyze button
analyzeBtn.addEventListener('click', async () => {
  const sentence = sentenceInput.value.trim();
  
  if (!sentence) {
    alert('Please enter a sentence to analyze');
    return;
  }

  analyzeBtn.disabled = true;
  analyzeBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing...';
  proceedBtn.disabled = true;

  try {
    const response = await fetch('/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ sentence })
    });

    const data = await response.json();
    
    // FIXED: Access data.analysis instead of data directly
    const analysis = data.success ? data.analysis : null;
    
    if (!analysis) {
      throw new Error(data.error || 'Analysis failed');
    }

    // Check for redirect
    if (analysis.redirect_flag && analysis.redirect_url) {
      window.location.href = analysis.redirect_url;
      return;
    }

    // Display result
    analysisResult.style.display = 'block';
    analysisResult.innerHTML = `
      <div class="alert ${analysis.proceed_button ? 'alert-success' : 'alert-warning'}">
        <strong>Analysis Result:</strong>
        <p>${analysis.finalAnalysis}</p>
        
        ${analysis.suggested_action ? `
          <hr>
          <p><strong>💡 Suggestion:</strong> ${analysis.suggested_action}</p>
        ` : ''}
        
        ${analysis.example_query ? `
          <p><strong>📝 Example:</strong> "${analysis.example_query}"</p>
        ` : ''}
      </div>

      <div class="details-section">
        <h5>📊 Detailed Analysis</h5>
        <div class="row">
          <div class="col-md-6">
            <div class="analysis-card">
              <strong>Intent:</strong> ${analysis.intent.status}
              ${analysis.intent.value ? ` (${analysis.intent.value})` : ''}
            </div>
          </div>
          <div class="col-md-6">
            <div class="analysis-card">
              <strong>Process:</strong> ${analysis.process.status}
              ${analysis.process.value ? ` (${analysis.process.value})` : ''}
            </div>
          </div>
          <div class="col-md-6">
            <div class="analysis-card">
              <strong>Action:</strong> ${analysis.action.status}
              ${analysis.action.value ? ` (${analysis.action.value})` : ''}
            </div>
          </div>
          <div class="col-md-6">
            <div class="analysis-card">
              <strong>Filters:</strong> ${analysis.filters.status}
            </div>
          </div>
        </div>
      </div>
    `;

    // Enable proceed button if analysis was successful
    if (analysis.proceed_button) {
      proceedBtn.disabled = false;
    }

  } catch (error) {
    console.error('Error:', error);
    analysisResult.style.display = 'block';
    analysisResult.innerHTML = `
      <div class="alert alert-danger">
        <strong>Error:</strong> ${error.message}
        <p>Please try again or check the console for details.</p>
      </div>
    `;
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.innerHTML = '<i class="fas fa-search"></i> Analyze Intent';
  }
});

// Proceed button
proceedBtn.addEventListener('click', () => {
  alert('Proceeding with the action...');
  // Add your proceed logic here
});

// Clear button
clearBtn.addEventListener('click', () => {
  sentenceInput.value = '';
  charCount.textContent = '0';
  analysisResult.style.display = 'none';
  proceedBtn.disabled = true;
  analyzeBtn.disabled = false;
});

// Refresh logs button
refreshBtn.addEventListener('click', async () => {
  try {
    const response = await fetch('/api/logs');
    const data = await response.json();
    
    if (data.success && data.logs) {
      logsTableBody.innerHTML = '';
      
      data.logs.forEach(log => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${new Date(log.timestamp).toLocaleString()}</td>
          <td>${log.sentence}</td>
          <td>${log.analysis.finalAnalysis}</td>
        `;
        logsTableBody.appendChild(row);
      });
    }
  } catch (error) {
    console.error('Error fetching logs:', error);
  }
});

// Load logs on page load
window.addEventListener('DOMContentLoaded', () => {
  refreshBtn.click();
});
