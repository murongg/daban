// A running image is deletion-locked on Windows; stdin lets its owning test release it.
process.stdin.once('end', () => process.stdin.pause());
process.stdin.resume();
process.stdout.write('READY\n');
