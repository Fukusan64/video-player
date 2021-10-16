import childProcess from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import ctx from 'axel';
import bmpJs from 'bmp-js';
import ora from 'ora';

const exec = promisify(childProcess.exec);
const spinner = ora();

const FPS = 30;

const init = async () => await exec('rm -rf ./tmp');
const getWH = () => [ctx.cols * 2, ctx.rows * 4];
const convertToBmps = async (w, h) => {
  const src = process.argv[2];
  await exec('mkdir -p ./tmp');
  await exec(
    `ffmpeg` +
      ` -i "${src}"` +
      ` -vf` +
      ` "yadif=deint=interlaced,` +
      ` extractplanes=y,` +
      ` scale=w=trunc(ih*dar/2)*2:h=trunc(ih/2)*2,` +
      ` setsar=1/1,` +
      ` fps=${FPS},` +
      ` scale=w=${w}:h=${h}:force_original_aspect_ratio=1,` +
      ` pad=w=${w}:h=${h}:x=(ow-iw)/2:y=(oh-ih)/2:color=#000000"` +
      ` -vcodec bmp ./tmp/image_%d.bmp`
  );
  return parseInt((await exec('ls ./tmp/ | wc -l')).stdout, 10);
};
const makeAAs = async (frameCount, w, h, progress) => {
  const AAs = [];
  const [cw, ch] = [w / 2, h / 4];
  {
    const AAFileName = './tmp/frame_0.txt';
    const AAFile = await fs.open(AAFileName, 'w+');
    try {
      await AAFile.write(('\u2800'.repeat(cw) + '\n').repeat(ch));
    } finally {
      await AAFile?.close();
    }
    AAs.push(AAFileName);
  }

  const range = (stop) =>
    Array(stop)
      .fill()
      .map((_, i) => i + 1);
  const chunking = (array, step) => {
    const chunkedArray = [];
    for (let index = 0; index < array.length; index += step) {
      chunkedArray.push(array.slice(index, index + step));
    }
    return chunkedArray;
  };
  for (const processRange of chunking(range(frameCount), 100)) {
    const chunkedFrameFileName = await Promise.all(
      processRange.map((i) =>
        (async () => {
          const frame = new Uint8Array(
            bmpJs.decode(await fs.readFile(`./tmp/image_${i}.bmp`)).data
          )
            .filter((_, i) => (i - 1) % 4 === 0)
            .map((d) => (d > 128 ? 1 : 0));
          const AAFileName = `./tmp/frame_${i}.txt`;
          {
            const codeTable = [[], [], [], []];
            codeTable[0][0] = 2 ** 0;
            codeTable[1][0] = 2 ** 1;
            codeTable[2][0] = 2 ** 2;
            codeTable[0][1] = 2 ** 3;
            codeTable[1][1] = 2 ** 4;
            codeTable[2][1] = 2 ** 5;
            codeTable[3][0] = 2 ** 6;
            codeTable[3][1] = 2 ** 7;

            let AAFile = null;
            try {
              AAFile = await fs.open(AAFileName, 'w+');
              for (let y = 0; y < ch; y++) {
                let frameLine = '';
                for (let x = 0; x < cw; x++) {
                  const [px, py] = [x * 2, y * 4];
                  let code = 0x2800;
                  codeTable.forEach((lines, dy) =>
                    lines.forEach((point, dx) => {
                      code += point * frame[(py + dy) * w + px + dx];
                    })
                  );
                  frameLine += String.fromCodePoint(code);
                }
                await AAFile.write(frameLine + '\n');
              }
            } finally {
              await AAFile?.close();
            }
          }
          return AAFileName;
        })()
      )
    );
    AAs.push(...chunkedFrameFileName);
    await progress(AAs.length / frameCount);
  }
  return AAs;
};
const makeDiffList = async (AAFileNames) => {
  const readFile = async (fileName) =>
    (await fs.readFile(fileName)).toString().split('\n');
  let beforeFrameData = await readFile(AAFileNames[0]);
  const diffs = [];
  for (let i = 1; i < AAFileNames.length; i++) {
    const currentFrameData = await readFile(AAFileNames[i]);
    const diff = [];
    for (let y = 0; y < currentFrameData.length; y++) {
      for (let x = 0; x < currentFrameData[y].length; x++) {
        if (beforeFrameData[y][x] !== currentFrameData[y][x])
          diff.push([x + 1, y + 1, currentFrameData[y][x]]);
      }
    }
    diffs.push(diff);
    beforeFrameData = currentFrameData;
  }
  return diffs;
};

const runAnimation = (diffs) =>
  new Promise((res) => {
    let i = 0;
    const id = setInterval(() => {
      if (i >= diffs.length) {
        clearInterval(id);
        res();
        return;
      }
      diffs[i].forEach((e) => ctx.text(...e));
      ctx.cursor.restore();
      i++;
    }, 1000 / FPS);
  });

try {
  spinner.start('init...');
  await init();
  spinner.succeed();

  spinner.start('get w and h');
  const [w, h] = getWH();
  spinner.succeed();

  spinner.start('convert video to bmp files');
  const frameCount = await convertToBmps(w, h);
  spinner.succeed(`get ${frameCount} frames`);

  spinner.start('make AAs');
  const AAFileNames = await makeAAs(
    frameCount,
    w,
    h,
    (progress) => (spinner.text = `make AAs: ${Math.round(progress * 100)}%`)
  );
  spinner.succeed();

  spinner.start('make diff list');
  const diffs = await makeDiffList(AAFileNames);
  spinner.succeed();

  console.clear();

  await runAnimation(diffs);
} catch (e) {
  if (spinner.isSpinning) spinner.fail();
  console.error(e);
} finally {
  await init();
}
