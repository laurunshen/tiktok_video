import { GoogleGenAI } from '@google/genai'
import { readFile } from 'fs/promises'
import path from 'path'

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

async function imageToInlinePart(filePath, originalName) {
  const buffer = await readFile(filePath)
  const ext = path.extname(originalName).toLowerCase()
  const mimeTypeMap = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  }
  return {
    inlineData: {
      mimeType: mimeTypeMap[ext] || 'image/jpeg',
      data: buffer.toString('base64'),
    },
  }
}

export async function selectImagesAndGeneratePrompt({
  imageFiles,       // multer file objects with .path and .originalname
  imageUrls,        // [{ index, url, originalname }] - kie.ai uploaded URLs
  videoAnalysis,    // result from analyzeReferenceVideo
  userDescription,  // user's free-text idea
  targetDuration,   // 15
}) {
  const parts = []

  parts.push({
    text: `You are an expert AI video production assistant specializing in e-commerce UGC (User Generated Content) promotional videos across all product categories. You understand Seedance2 video generation prompts deeply.

Here are ${imageFiles.length} product images to choose from:`,
  })

  for (let i = 0; i < imageFiles.length; i++) {
    parts.push({ text: `[Image ${i + 1}: ${imageFiles[i].originalname}]` })
    parts.push(await imageToInlinePart(imageFiles[i].path, imageFiles[i].originalname))
  }

  parts.push({
    text: `
=== REFERENCE VIDEO ANALYSIS ===
Product category: ${videoAnalysis.product_category || 'consumer product'}
Product: ${videoAnalysis.product_description || ''}
Presenter: ${videoAnalysis.presenter_description}
Filming style: ${videoAnalysis.filming_style}
Speaking style: ${videoAnalysis.speaking_style}
Shot sequence: ${videoAnalysis.shot_sequence}
Key selling points: ${(videoAnalysis.key_selling_points || []).join(', ')}
UGC style notes: ${videoAnalysis.ugc_style_notes || ''}
Mood: ${videoAnalysis.mood}
Original script: ${videoAnalysis.script}

User's additional ideas: ${userDescription || 'None provided'}
Target duration: ${targetDuration} seconds

=== YOUR TASKS ===

TASK 1 - Image selection:
Select the best 5-9 images from the uploaded product photos.
Prioritize: hero/overview shot, key feature close-ups, texture/material details, functional details (buttons, zippers, clasps, labels, etc.)
Do NOT hardcode category-specific assumptions — judge based on what you actually see in the images.

TASK 2 - Generate a Seedance2 prompt using this FIXED STRUCTURE:

The prompt MUST follow this exact template structure (fill in the blanks based on the video analysis above):

---
[IMAGE REFERENCES]
List each selected image and what it shows, e.g.:
"Reference @Image1 for [what it shows]. @Image2 for [what it shows]..." etc.

[OPENING LINE]
"Generate a ${targetDuration}-second authentic UGC-style promotional video for [product from video analysis]."

[PRESENTER]
Describe the presenter in full physical detail based on: ${videoAnalysis.presenter_description}
Include: approximate age, body type, hair (color, length, how it's casually styled), skin tone and any natural features (freckles, natural skin texture — NOT "flawless skin").
What they are wearing (casual everyday clothing).
Energy and body language: warm, conversational, uses hands to gesture.
IMPORTANT: describe them as a real everyday person, NOT a model or influencer. Emphasize natural, relatable appearance over attractiveness.

[SHOT SEQUENCE - use exact second timestamps]
[0–Xs] [shot type, e.g. Medium close-up] — what presenter does/says. Spoken words in quotes.
[Xs–Ys] Cut to product detail shots referencing @ImageN — describe exactly what detail is shown and what is said.
[Ys–${targetDuration}s] Final shot — call to action, what presenter does and says.

Each spoken line must be a natural, conversational sentence extracted/compressed from the original script. Keep the authentic UGC voice.

[STYLE - CRITICAL: enforce ALL of these]
Camera: ${videoAnalysis.filming_style}. Handheld or phone-propped, slightly unsteady — NOT a professional tripod look.
Lighting: Soft, uneven natural window light from one side. NOT studio lighting, NOT ring light, NOT perfectly even.
Background: Real home environment — visible door, furniture, or wall with slight imperfections. NOT a clean studio backdrop.
Color grade: Warm, slightly flat, no heavy filters. Looks like shot on an iPhone. NOT cinematic color grading.
Aspect ratio: 9:16 vertical for TikTok/Reels.

PRESENTER AUTHENTICITY (critical — fight Seedance's tendency toward over-glamorization):
- Minimal or no visible makeup. Natural skin with pores, slight imperfections, maybe light freckles. NOT heavy foundation or contouring.
- Hair should look casually styled or slightly imperfect — NOT salon-perfect or heavily styled.
- Expression and energy: warm, unscripted-feeling, like talking to a friend. NOT model-posing or overly rehearsed smiling.
- Body language: relaxed, uses hands naturally to gesture and point at product. NOT stiff or posed.
- Clothing: everyday casual wear (tank top, t-shirt, loungewear) that a real person would wear at home.

CONTENT SPECIFICITY (make it feel real and relatable):
- Include at least 2 specific real-life scenarios that cause the problem the product solves (e.g. "after breastfeeding", "after weight loss") — extract from: ${(videoAnalysis.key_selling_points || []).join(', ')}
- Show the product BEING WORN or USED, not just held up. Demonstrate fit/function on the body.
- Include at least one specific technical/functional detail that adds credibility.
- End with a specific, casual call-to-action (not generic "buy now" — something like "size up", "link below", "grab yours").

WHAT TO AVOID (tell Seedance explicitly):
No professional makeup artist look. No perfect studio lighting. No clean white seamless backdrop. No model poses. No overly enthusiastic scripted energy.
---

IMPORTANT RULES:
- Do NOT use any category-specific words (e.g. "lingerie", "skincare", "bra") in the structure itself — describe what you see from the images
- The structure above is FIXED for all product types — only the content changes
- @ImageN references must use the original upload order number (1-based)
- Spoken dialogue must sound natural and conversational, not scripted

Return ONLY this valid JSON, no markdown fences, no explanation:
{
  "selected_image_indices": [1, 3, 5, 7, 9],
  "compressed_script": "The ${targetDuration}-second compressed spoken script only",
  "seedance_prompt": "The full Seedance2 prompt following the template structure above",
  "reasoning": "Brief explanation of image selection choices"
}`,
  })

  const response = await genai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: [{ parts }],
  })

  // 兼容不同响应结构
  if (!response.candidates || response.candidates.length === 0) {
    console.error('Gemini select 返回空 candidates，完整响应:', JSON.stringify(response, null, 2))
    throw new Error(`Gemini 无返回内容，可能被安全过滤拦截。promptFeedback: ${JSON.stringify(response.promptFeedback)}`)
  }
  const text = response.candidates[0].content.parts[0].text
  const cleaned = text.replace(/```json|```/g, '').trim()

  let result
  try {
    result = JSON.parse(cleaned)
  } catch (e) {
    console.error('Gemini select JSON parse error:', e)
    console.error('Raw response:', text)
    throw new Error('Failed to parse Gemini image selection response')
  }

  // Map selected indices (1-based) to their kie.ai URLs
  result.selected_image_urls = result.selected_image_indices.map(idx => {
    const found = imageUrls.find(u => u.index === idx - 1)
    return found ? found.url : null
  }).filter(Boolean)

  return result
}
