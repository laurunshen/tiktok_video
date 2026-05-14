import Anthropic from '@anthropic-ai/sdk'
import { readFile } from 'fs/promises'
import path from 'path'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// 将图片文件转为base64 content block
async function imageToContentBlock(filePath) {
  const buffer = await readFile(filePath)
  const base64 = buffer.toString('base64')
  const ext = path.extname(filePath).toLowerCase()
  const mediaTypeMap = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  }
  const mediaType = mediaTypeMap[ext] || 'image/jpeg'
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: base64 },
  }
}

export async function selectImagesAndGeneratePrompt({
  imageFiles,       // multer file objects with .path and .originalname
  imageUrls,        // [{ index, url, originalname }] - kie.ai uploaded URLs
  videoAnalysis,   // result from Gemini
  userDescription, // user's free-text idea
  targetDuration,  // 15
}) {
  // Build image content blocks with index labels
  const imageBlocks = []
  for (let i = 0; i < imageFiles.length; i++) {
    imageBlocks.push({
      type: 'text',
      text: `[Image ${i + 1}: ${imageFiles[i].originalname}]`,
    })
    imageBlocks.push(await imageToContentBlock(imageFiles[i].path))
  }

  const systemPrompt = `You are an expert AI video production assistant specializing in e-commerce lingerie UGC (User Generated Content) promotional videos. You understand Seedance2 video generation prompts deeply.

Your task:
1. Analyze the uploaded product images
2. Select the best 5-9 images for a ${targetDuration}-second video (prioritize: hero shot, key detail close-ups, fabric texture, hardware details)
3. Generate a complete Seedance2 video generation prompt that replicates the reference video style

Return ONLY valid JSON with no markdown or explanation.`

  const userPrompt = `Here are all the product images (${imageFiles.length} total):

${imageBlocks.filter(b => b.type === 'text').map(b => b.text).join('\n')}

Reference video analysis:
${JSON.stringify(videoAnalysis, null, 2)}

User's additional ideas:
${userDescription || 'None provided'}

Target duration: ${targetDuration} seconds

Please:
1. Select the best images for the video (return their image numbers 1-${imageFiles.length})
2. Generate a Seedance2 prompt in English that:
   - Replicates the presenter style: ${videoAnalysis.presenter_description}
   - Replicates the filming style: ${videoAnalysis.filming_style}
   - Replicates the speaking style: ${videoAnalysis.speaking_style}
   - Compresses the full script into a ${targetDuration}-second version keeping the most impactful selling points
   - References the selected images using @Image1, @Image2... format (numbered by upload order)
   - Includes shot sequence instructions matching the reference video

Return this exact JSON structure:
{
  "selected_image_indices": [1, 3, 5, 7, 9],
  "compressed_script": "The 15-second compressed English script",
  "seedance_prompt": "The full Seedance2 prompt in English referencing @Image1 @Image2 etc.",
  "reasoning": "Brief explanation of image selection choices"
}`

  // Build the full message with interleaved text + images
  const contentBlocks = []
  
  // Add the text intro
  contentBlocks.push({
    type: 'text',
    text: `Here are all the product images (${imageFiles.length} total):`,
  })
  
  // Add images with their labels
  for (let i = 0; i < imageFiles.length; i++) {
    contentBlocks.push({
      type: 'text',
      text: `[Image ${i + 1}: ${imageFiles[i].originalname}]`,
    })
    contentBlocks.push(await imageToContentBlock(imageFiles[i].path))
  }

  // Add the rest of the prompt
  contentBlocks.push({
    type: 'text',
    text: `
Reference video analysis:
${JSON.stringify(videoAnalysis, null, 2)}

User's additional ideas:
${userDescription || 'None provided'}

Target duration: ${targetDuration} seconds

Please:
1. Select the best 5-9 images for the video (return their image numbers 1-${imageFiles.length})
2. Generate a Seedance2 prompt in English that:
   - Replicates the presenter style: ${videoAnalysis.presenter_description}
   - Replicates the filming style: ${videoAnalysis.filming_style}
   - Replicates the speaking style: ${videoAnalysis.speaking_style}
   - Compresses the full script into a ${targetDuration}-second version keeping the most impactful selling points
   - References the selected images using @Image1, @Image2... format (numbered by upload order you received them)
   - Includes shot sequence instructions matching the reference video

Return this exact JSON structure:
{
  "selected_image_indices": [1, 3, 5, 7, 9],
  "compressed_script": "The 15-second compressed English script",
  "seedance_prompt": "The full Seedance2 prompt in English referencing @Image1 @Image2 etc.",
  "reasoning": "Brief explanation of image selection choices"
}

Return ONLY valid JSON, no markdown fences, no explanation outside the JSON.`,
  })

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: contentBlocks }],
  })

  const text = response.content[0].text
  const cleaned = text.replace(/```json|```/g, '').trim()

  try {
    const result = JSON.parse(cleaned)
    
    // Map selected image indices to their kie.ai URLs
    result.selected_image_urls = result.selected_image_indices.map(idx => {
      const found = imageUrls.find(u => u.index === idx - 1) // idx is 1-based
      return found ? found.url : null
    }).filter(Boolean)

    return result
  } catch (e) {
    console.error('Claude JSON parse error:', e)
    console.error('Raw response:', text)
    throw new Error('Failed to parse Claude image selection response')
  }
}
