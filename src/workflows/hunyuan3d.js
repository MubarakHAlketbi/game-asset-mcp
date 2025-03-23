import { promises as fs } from "fs";
import path from "path";
import { log } from "../logger.js";
import { saveFileFromData } from "../utils.js";

/**
 * Workflow for Hunyuan3D space
 */
export async function processHunyuan3d({
  modelClient,
  imageFile,
  imagePath,
  // Removed processedImagePath as it's set internally
  prompt,
  operationId,
  toolName,
  assetsDir,
  hfToken,
  modelSpace,
  workDir,
  config,
  retryWithBackoff,
  notifyResourceListChanged
}) {
  const { 
    model3dSteps, 
    model3dGuidanceScale, 
    model3dSeed, 
    model3dOctreeResolution, 
    model3dRemoveBackground 
  } = config;
  
  await log('INFO', "Using Hunyuan3D-2 space", workDir);
  
  // Hunyuan3D doesn't have a check_input_image endpoint, so we skip that step
  await log('INFO', `Using Hunyuan3D-2 space - skipping image validation step`, workDir);
  
  // Hunyuan3D doesn't have a preprocess endpoint, but has built-in background removal
  await log('INFO', `Using Hunyuan3D-2 space - using built-in background removal`, workDir);
  
  // Save the original image as the processed image
  const processedResult = await saveFileFromData(
    imageFile,
    "3d_processed",
    "png",
    toolName,
    assetsDir,
    hfToken,
    modelSpace,
    workDir
  );
  const processedImagePath = processedResult.filePath;
  await log('INFO', `Preprocessed image saved at: ${processedImagePath}`, workDir);
  
  // Notify clients that a new resource is available
  await notifyResourceListChanged();
  
  // Generate 3D model in one step with generation_all
  await log('DEBUG', "Generating 3D model with Hunyuan3D-2...", workDir);
  const processedImageFile = await fs.readFile(processedImagePath);
  
  // Use configured values or defaults for Hunyuan3D-2 with validation
  // Hunyuan3D-2 steps range: 20-50
  let steps = model3dSteps !== null ? model3dSteps : 20; // Default: 20
  steps = Math.max(20, Math.min(50, steps));
  
  // Guidance scale already validated (0.0-100.0)
  const guidanceScale = model3dGuidanceScale !== null ? model3dGuidanceScale : 5.5; // Default: 5.5
  
  // Seed already validated (0-10000000)
  const seed = model3dSeed !== null ? model3dSeed : 1234; // Default: 1234
  
  // Validate octree resolution (valid options: "256", "384", "512")
  const validOctreeResolutions = ["256", "384", "512"];
  const octreeResolution = validOctreeResolutions.includes(model3dOctreeResolution)
    ? model3dOctreeResolution
    : "256";
  
  await log('INFO', `Hunyuan3D-2 parameters - steps: ${steps}, guidance_scale: ${guidanceScale}, seed: ${seed}, octree_resolution: ${octreeResolution}, remove_background: ${model3dRemoveBackground}`, workDir);
  
  // Hunyuan3D-2 uses generation_all endpoint to generate both white and textured meshes
  await log('INFO', "Using Hunyuan3D-2 space - using generation_all endpoint", workDir);
  const modelResult = await retryWithBackoff(async () => {
    return await modelClient.predict("/generation_all", [
      prompt,
      new File([processedImageFile], path.basename(processedImagePath), { type: "image/png" }),
      steps,
      guidanceScale,
      seed,
      octreeResolution,
      model3dRemoveBackground
    ]);
  }, operationId, 5); // More retries for this critical step
  
  if (!modelResult || !modelResult.data || !modelResult.data.length) {
    throw new Error("3D model generation failed");
  }
  
  await log('DEBUG', "Successfully generated 3D model with Hunyuan3D-2", workDir);
  
  // Save debug information for troubleshooting
  const modelDebugFilename = path.join(assetsDir, `model_data_${Date.now()}.json`);
  await fs.writeFile(modelDebugFilename, JSON.stringify(modelResult, null, 2));
  await log('DEBUG', `Model data saved as JSON at: ${modelDebugFilename}`, workDir);
  
  // According to ground_truth.md, Hunyuan3D-2 returns:
  // 1. White Mesh (Download Button): result.data[0]
  // 2. Textured Mesh (Download Button): result.data[1]
  // 3. HTML Output: result.data[2]
  // 4. HTML Output: result.data[3]
  
  // Declare variables outside the if/else block for proper scope
  let objModelData, glbModelData;
  
  // For Hunyuan3D-2, the textured mesh URL is at result.data[1].url
  if (!modelResult.data[1] || !modelResult.data[1].url) {
    await log('WARN', `Textured mesh not found in result.data[1].url, falling back to white mesh`, workDir);
    // Fallback to white mesh if textured mesh is not available
    if (!modelResult.data[0] || !modelResult.data[0].url) {
      throw new Error("No valid mesh found in the response");
    }
    // Use white mesh for both OBJ and GLB
    objModelData = modelResult.data[0];
    glbModelData = modelResult.data[0];
    await log('DEBUG', `Hunyuan3D-2: Using white mesh from modelResult.data[0] for both OBJ and GLB`, workDir);
  } else {
    // Use textured mesh for both OBJ and GLB
    objModelData = modelResult.data[1]; // Textured mesh
    glbModelData = modelResult.data[1]; // Textured mesh
    await log('DEBUG', `Hunyuan3D-2: Using textured mesh from modelResult.data[1] for both OBJ and GLB`, workDir);
  }
  
  // Save both model formats and notify clients of resource changes
  const objResult = await saveFileFromData(
    objModelData, 
    "3d_model", 
    "obj", 
    toolName, 
    assetsDir, 
    hfToken, 
    modelSpace, 
    workDir
  );
  await log('INFO', `OBJ model saved at: ${objResult.filePath}`, workDir);
  
  // Notify clients that a new resource is available
  await notifyResourceListChanged();
  
  const glbResult = await saveFileFromData(
    glbModelData, 
    "3d_model", 
    "glb", 
    toolName, 
    assetsDir, 
    hfToken, 
    modelSpace, 
    workDir
  );
  await log('INFO', `GLB model saved at: ${glbResult.filePath}`, workDir);
  
  // Notify clients that a new resource is available
  await notifyResourceListChanged();
  
  return {
    objResult,
    glbResult
  };
}