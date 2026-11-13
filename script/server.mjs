$.verbose = true
cd('server')
await $`./gradlew :server:assembleRelease`
await fs.remove('../resources/devicedock.dex')
await fs.move('devicedock.dex', '../resources/devicedock.dex')
