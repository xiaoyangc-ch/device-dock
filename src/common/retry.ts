export async function retryOnce<T>(
  task: () => Promise<T>,
  delayMs = 600,
): Promise<T> {
  try {
    return await task()
  } catch {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return task()
  }
}
