const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');

/**
 * Runs a LibreOffice headless conversion command.
 * LibreOffice's --convert-to can fail intermittently under concurrent load
 * (it uses a single profile lock by default), so we give each job its own
 * isolated user profile directory via -env:UserInstallation.
 */
function runSoffice(args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn('soffice', args, { cwd });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error('Failed to launch LibreOffice (soffice): ' + err.message)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`soffice exited with code ${code}: ${stderr.slice(0, 500)}`));
    });
    // Hard timeout — a single bad file should never hang the worker forever
    const t = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('soffice conversion timed out after 60s'));
    }, 60_000);
    proc.on('close', () => clearTimeout(t));
  });
}

/**
 * Converts a .doc (or passes through a .docx) into a .docx file living in workDir.
 * Returns the absolute path to the resulting .docx.
 */
async function convertDocOrDocxToCleanDocx(inputPath, workDir) {
  const ext = path.extname(inputPath).toLowerCase();

  if (ext === '.docx') {
    return inputPath; // already in the format we need
  }

  if (ext !== '.doc') {
    throw new Error(`Unsupported file extension: ${ext}`);
  }

  const profileDir = path.join(workDir, 'lo-profile');
  await fs.mkdir(profileDir, { recursive: true });

  await runSoffice(
    [
      '--headless',
      '--norestore',
      `-env:UserInstallation=file://${profileDir}`,
      '--convert-to', 'docx',
      '--outdir', workDir,
      inputPath
    ],
    workDir
  );

  const expected = path.join(workDir, path.basename(inputPath, '.doc') + '.docx');
  if (!fsSync.existsSync(expected)) {
    throw new Error('LibreOffice did not produce the expected .docx output');
  }
  return expected;
}

module.exports = { convertDocOrDocxToCleanDocx };
