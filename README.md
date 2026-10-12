# Brika Camera

A phone web app for taking good photos of electrical panels for **Brika Designer**:
it shows when the phone is level, finds the mounting plate live, takes the photo when everything is
right, straightens the angle, crops to the plate and saves the photo with the panel's name.

Nothing is uploaded anywhere: the camera picture is processed on the phone and saved to the phone.

## Put it on your phone (once)

The camera only works on a page served over **https**, so the app is hosted free on GitHub Pages.

1. **GitHub Desktop** → *File → Add local repository…* → choose this `BrikaCamera` folder.
   If it says it is not a repository, click *create a repository*, then **Publish repository**.
   Untick *Keep this code private* (free GitHub Pages needs a public repository; it only holds
   the app code, never your photos).
2. On **github.com** open the repository → **Settings → Pages** → *Source: Deploy from a branch* →
   branch **main**, folder **/ (root)** → **Save**. After a minute the page shows the address,
   e.g. `https://YOUR-NAME.github.io/BrikaCamera/`.
3. On the Android phone open that address in **Chrome** → menu **⋮ → Add to Home screen → Install**.
   Start it from the home screen icon and allow the camera.

After the first start it also works without signal (offline cache).

**Updating:** change files, commit and push in GitHub Desktop. Raise `VERSION` in `sw.js`
(e.g. `brika-camera-v2`) so phones load the new files; close and reopen the app twice.

## Using it

**Best picture quality:** on the first screen use **Take it with the phone's camera app** (or
**Straighten a photo from the gallery** for a photo you already took). The phone's own camera uses
night mode, HDR and noise reduction, which a web page can't; the photo then comes back to this app
for corners, straightening and the file name. The app's own camera (*Start camera*) gives the
level and live outline, and now takes a full-resolution still by default instead of a video frame.

1. **Panel name** – every photo is saved as `Panel name_01.jpg`, `_02`, …
   With the plate size filled in: `Panel name_600x1200mm_01.jpg`.
2. **Whole panel** or **Label close-up** (for nameplates; type the tag, e.g. `QF2`, on the
   camera screen → `Panel name_QF2_01.jpg`).
3. **Plate size in mm** (optional, from the drawing or a tape measure) gives the straightened
   photo the exact proportions. Without it the app estimates them from the perspective.
4. On the camera screen:
   - the **dot in the circle** is the level: keep it in the middle (green);
   - the **outline** is the plate the app found: green = ready, yellow = could be better,
     red = fix the hint at the top. **Switch outline** if it picked the cabinet frame instead
     of the plate;
   - with **Auto** on, the photo is taken by itself after you hold still for about a second;
   - **Light** switches the phone's torch (if Chrome allows it on your phone);
   - tap the picture to focus there.
5. **Check the corners**: drag a corner onto the plate corner (a magnifier shows the spot).
   *Other outline* jumps to another rectangle the app found, *Whole photo* skips cropping.
6. **Result**: checks for blur, glare, light and detail. **Save to phone** puts the photo in the
   phone's **Download** folder; Google Photos / Gallery shows it under the album *Download*.
   Chrome may ask once whether the site may download files – allow it.

Then copy the photos to the laptop (cable, Google Photos, Drive …) and use them in the Designer
(reference photo). A straightened, cropped photo lines up with the panel without manual fitting.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `app.css` | the four screens: setup, camera, corners, result |
| `js/app.js` | camera, level sensor, live guidance, saving |
| `js/vision.js` | plate finding, straightening, proportions, photo checks (no libraries) |
| `sw.js`, `manifest.webmanifest`, `icons/` | installable app + offline cache |
| `tests/` | tests with generated panel pictures and a fake camera |

## Tests (on the laptop)

```
pip install playwright opencv-python pillow numpy
playwright install chromium
python tests/run_tests.py          # plate finding, straightening, level, advice
python tests/run_app_test.py       # whole app with a fake camera; screenshots in tests/out/
```

## Ideas for later

- Tall panels in two halves (top/bottom) joined into one picture.
- Send photos straight to the laptop over Wi-Fi.
- Tune the plate finder with real panel photos (send some where it picks the wrong outline).
