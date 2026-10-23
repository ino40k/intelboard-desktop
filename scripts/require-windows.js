if (process.platform !== 'win32') throw new Error('Build the Windows installer on Windows (or use the Windows GitHub Actions job) so native dependencies match the target.');
