/* ==========================================
   PrithviNet — AI Copilot Frontend Logic
   ========================================== */

document.addEventListener('DOMContentLoaded', () => {
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const messagesArea = document.getElementById('chat-messages');
    const typingIndicator = document.getElementById('typing-indicator');
    const btnSend = document.getElementById('btn-send');

    const perms = (window.PrithviNet && window.PrithviNet.getPermissions)
      ? window.PrithviNet.getPermissions()
      : { copilot: true };

    if (!perms.copilot) {
        chatInput.disabled = true;
        btnSend.disabled = true;
        appendMessage('bot', 'Copilot access is disabled for your current role.');
        return;
    }

    // Auto-resize textarea
    chatInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight < 120 ? this.scrollHeight : 120) + 'px';
        btnSend.disabled = this.value.trim().length === 0;
    });

    // Enter to submit (Shift+Enter for newline)
    chatInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if(!btnSend.disabled) chatForm.dispatchEvent(new Event('submit'));
        }
    });

    // Handle Quick Prompts
    window.setPrompt = function(text) {
        chatInput.value = text;
        chatInput.dispatchEvent(new Event('input')); // Trigger resize and btn enable
        chatInput.focus();
    };

    // Chat Submission
    chatForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = chatInput.value.trim();
        if (!text) return;

        // Reset Input
        chatInput.value = '';
        chatInput.dispatchEvent(new Event('input'));
        
        // Append User Msg
        appendMessage('user', text);
        
        // Disable input & show loading
        chatInput.disabled = true;
        btnSend.disabled = true;
        typingIndicator.classList.add('active');
        messagesArea.scrollTop = messagesArea.scrollHeight;

        try {
            // Assume Location ID 1 (Bhilai Steel Plant / generic demo location) for context injection
            const response = await fetch('/api/copilot/ask', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text, location_id: 1 })
            });

            const data = await response.json();

            if (data.status === 'ok') {
                appendMessage('bot', data.text);
            } else {
                appendMessage('bot', `**Error:** The AI engine failed to process the request. \n\n*${data.error || 'Unknown error'}*`);
            }
        } catch (err) {
            console.error(err);
            appendMessage('bot', '**Connection Error:** Failed to reach the Copilot backend. Ensure the server is running and the internet is connected.');
        } finally {
            typingIndicator.classList.remove('active');
            chatInput.disabled = false;
            chatInput.focus();
            messagesArea.scrollTop = messagesArea.scrollHeight;
        }
    });

    function appendMessage(sender, text) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `msg ${sender}`;
        
        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble';
        
        // Parse Markdown if it's the bot responding
        if (sender === 'bot') {
            bubble.innerHTML = marked.parse(text);
        } else {
            bubble.textContent = text;
        }
        
        const meta = document.createElement('div');
        meta.className = 'msg-meta';
        meta.textContent = `${sender === 'user' ? 'You' : 'Copilot'} • ${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;

        msgDiv.appendChild(bubble);
        msgDiv.appendChild(meta);

        if (sender === 'bot') {
            const sumBtn = document.createElement('button');
            sumBtn.className = 'tldr-btn';
            sumBtn.textContent = 'Summarize this message';
            sumBtn.style.cssText = 'margin-top:10px; padding:4px 8px; font-size:12px; cursor:pointer; background:rgba(56,189,248,0.1); border:1px solid rgba(56,189,248,0.3); color:#38bdf8; border-radius:4px;';
            
            sumBtn.addEventListener('click', async () => {
                sumBtn.textContent = 'Summarizing...';
                sumBtn.disabled = true;
                
                try {
                    const res = await fetch('/api/copilot/summarize-msg', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: text })
                    });
                    const data = await res.json();
                    
                    if (data.status === 'ok') {
                        const tldrBox = document.createElement('div');
                        tldrBox.style.cssText = 'margin-top:10px; padding:10px; background:#f0fdf4; border-left:4px solid #16a34a; font-size:13px; color:#166534; border-radius:4px;';
                        tldrBox.innerHTML = `<strong>TL;DR:</strong> ${data.summary}`;
                        
                        msgDiv.appendChild(tldrBox);
                        sumBtn.remove();
                    } else {
                        sumBtn.textContent = 'Error';
                    }
                } catch (e) {
                    sumBtn.textContent = 'Failed';
                }
            });
            
            msgDiv.appendChild(sumBtn);
        }

        messagesArea.appendChild(msgDiv);
        
        messagesArea.scrollTop = messagesArea.scrollHeight;
    }
});
