// Serverless Function: ทำหน้าที่เป็นตัวกลางระหว่างเว็บกับ Google Gemini API (ฟรี ไม่ต้องผูกบัตรเครดิต)
// คีย์ API จะถูกอ่านจาก Environment Variable บน Vercel เท่านั้น ไม่ปรากฏในโค้ดฝั่งเว็บเลย
// ฟังก์ชันนี้แปลงรูปแบบคำขอ/คำตอบให้เหมือนของเดิม (Anthropic-style) เพื่อไม่ต้องแก้โค้ดฝั่ง index.html เลย
// รองรับการลองรุ่นสำรองอัตโนมัติ ถ้ารุ่นหลักไม่ว่าง (high demand) จะลองรุ่นถัดไปในลิสต์ทันที

// เรียงจากรุ่นที่เบา/โควตาเยอะ ไปหารุ่นสำรอง เพื่อลดโอกาสเจอ "high demand"
const MODEL_FALLBACKS = [
  'gemini-2.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-2.0-flash-lite',
  'gemini-flash-latest'
];

async function callGemini(model, apiKey, body) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );
  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, system, max_tokens } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY ใน Environment Variables ของ Vercel' });
    }

    // แปลงข้อความจากรูปแบบเดิม (Anthropic-style: role + content) เป็นรูปแบบของ Gemini (role + parts)
    const contents = (messages || []).map(m => {
      const parts = [];
      if (typeof m.content === 'string') {
        parts.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        m.content.forEach(block => {
          if (block.type === 'text') {
            parts.push({ text: block.text });
          } else if (block.type === 'image' && block.source) {
            parts.push({ inline_data: { mime_type: block.source.media_type, data: block.source.data } });
          }
        });
      }
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });

    const body = {
      contents,
      generationConfig: { maxOutputTokens: max_tokens || 1000 }
    };
    if (system) {
      body.system_instruction = { parts: [{ text: system }] };
    }

    let lastError = null;
    for (const model of MODEL_FALLBACKS) {
      const result = await callGemini(model, apiKey, body);
      if (result.ok) {
        const text = (result.data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('\n');
        return res.status(200).json({ content: [{ type: 'text', text }], modelUsed: model });
      }
      lastError = result;
      // ถ้าเป็นปัญหาโควตา/ความหนาแน่นสูง (429/503) ให้ลองรุ่นถัดไปทันที
      // ถ้าเป็น error อื่น (เช่น คีย์ผิด, request ผิดรูปแบบ) ให้หยุดแล้วแจ้ง error ทันทีไม่ต้องลองรุ่นอื่นต่อ
      if (result.status !== 429 && result.status !== 503) break;
    }

    return res.status(lastError.status).json({
      error: (lastError.data.error?.message || 'Gemini API error') + ` (ลองแล้ว ${MODEL_FALLBACKS.length} รุ่นสำรอง)`
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
