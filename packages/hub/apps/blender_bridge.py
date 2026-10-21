# Agent HQ's side inside Blender: started by app-bridge.mjs as
#   blender [-b] [file.blend] --python blender_bridge.py -- --port N --token T --parent PID
# it serves newline-delimited JSON requests on 127.0.0.1:N, each carrying the
# session's token. Ops: ping · exec (Python with bpy; variables persist; set
# `result` to return a value) · render (PNG; a temporary camera/light when the
# scene has none, everything restored afterwards) · scene (a summary) · quit.
# With a window, requests run on Blender's main thread from a timer; in the
# background (-b) a plain loop serves them. When the bridge that started it
# goes away (killed, crashed), Blender quits on its own.
import contextlib
import io
import json
import math
import os
import queue
import socket
import sys
import threading
import time
import traceback

import bpy
import mathutils


def _args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = {}
    for i in range(0, len(argv) - 1):
        if argv[i].startswith('--'):
            out[argv[i][2:]] = argv[i + 1]
    return out


ARGS = _args()
PORT = int(ARGS.get('port', '0'))
TOKEN = ARGS.get('token', '')
PARENT = int(ARGS.get('parent', '0'))
BACKGROUND = bool(bpy.app.background)
NAMESPACE = {'bpy': bpy, 'mathutils': mathutils, 'math': math, 'os': os}
REQUESTS = queue.Queue()
STOP = threading.Event()


# --- ops ---------------------------------------------------------------------
def op_exec(request):
    code = str(request.get('code', ''))
    NAMESPACE.pop('result', None)
    buffer = io.StringIO()
    error = None
    with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
        try:
            exec(compile(code, '<agent>', 'exec'), NAMESPACE)
        except Exception:
            error = traceback.format_exc(limit=6)
    result = NAMESPACE.get('result')
    try:
        json.dumps(result)
    except (TypeError, ValueError):
        result = repr(result)
    output = buffer.getvalue()
    if len(output) > 20000:
        output = '…' + output[-20000:]
    return {'ok': error is None, 'output': output, 'result': result, 'error': error}


ENGINES = {
    'workbench': ['BLENDER_WORKBENCH'],
    'eevee': ['BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'],
    'cycles': ['CYCLES'],
}


def _set_engine(scene, name):
    for engine in ENGINES.get(str(name).lower(), ENGINES['workbench']):
        try:
            scene.render.engine = engine
            return engine
        except TypeError:
            continue
    return scene.render.engine


def _bounds(scene):
    points = []
    for obj in scene.objects:
        if obj.type not in {'MESH', 'CURVE', 'SURFACE', 'META', 'FONT', 'GPENCIL', 'GREASEPENCIL', 'VOLUME', 'POINTCLOUD', 'CURVES'}:
            continue
        try:
            if not obj.visible_get():
                continue
        except Exception:
            pass
        points.extend(obj.matrix_world @ mathutils.Vector(corner) for corner in obj.bound_box)
    if not points:
        return mathutils.Vector((0, 0, 0)), 1.0
    low = mathutils.Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    high = mathutils.Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    center = (low + high) / 2
    return center, max(max((p - center).length for p in points), 0.01)


def op_render(request):
    scene = bpy.context.scene
    render = scene.render
    saved = {
        'engine': render.engine,
        'x': render.resolution_x,
        'y': render.resolution_y,
        'percent': render.resolution_percentage,
        'filepath': render.filepath,
        'format': render.image_settings.file_format,
        'frame': scene.frame_current,
        'camera': scene.camera,
    }
    temporary = []
    try:
        engine = _set_engine(scene, request.get('engine') or 'workbench')
        width, height = request.get('width'), request.get('height')
        if width or height:
            aspect = saved['y'] / max(saved['x'], 1)
            width = int(width or round(int(height) / aspect))
            height = int(height or round(int(width) * aspect))
        else:
            scale = saved['percent'] / 100.0
            width, height = saved['x'] * scale, saved['y'] * scale
            shrink = min(1.0, 1280.0 / max(width, height, 1))
            width, height = int(width * shrink), int(height * shrink)
        render.resolution_x, render.resolution_y, render.resolution_percentage = max(width, 4), max(height, 4), 100
        if request.get('frame') is not None:
            scene.frame_set(int(request['frame']))
        if scene.camera is None:
            data = bpy.data.cameras.new('AgentHQ preview camera')
            camera = bpy.data.objects.new('AgentHQ preview camera', data)
            scene.collection.objects.link(camera)
            temporary.append(camera)
            center, radius = _bounds(scene)
            # a new camera fits its angle to the longer side; the shorter one limits the framing
            small, large = sorted((render.resolution_x, render.resolution_y))
            fov = 2 * math.atan(math.tan(data.angle / 2) * small / max(large, 1))
            distance = radius / math.sin(max(fov, 0.1) / 2) * 1.1
            direction = mathutils.Vector((1.0, -1.0, 0.75)).normalized()
            camera.location = center + direction * distance
            camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
            data.clip_start = max(distance - radius * 2, 0.01) / 10
            data.clip_end = distance + radius * 4
            scene.camera = camera
        if engine != 'BLENDER_WORKBENCH' and not any(obj.type == 'LIGHT' for obj in scene.objects):
            data = bpy.data.lights.new('AgentHQ preview light', 'SUN')
            data.energy = 3.0
            light = bpy.data.objects.new('AgentHQ preview light', data)
            light.rotation_euler = (math.radians(50), 0, math.radians(30))
            scene.collection.objects.link(light)
            temporary.append(light)
        path = os.path.abspath(str(request.get('path')))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        render.image_settings.file_format = 'PNG'
        render.filepath = path
        started = time.time()
        bpy.ops.render.render(write_still=True)
        if not os.path.exists(path) and os.path.exists(path + '.png'):
            path = path + '.png'
        if not os.path.exists(path):
            return {'ok': False, 'error': 'the render produced no file at ' + path}
        return {
            'ok': True,
            'path': path,
            'engine': engine,
            'width': render.resolution_x,
            'height': render.resolution_y,
            'camera': 'a temporary camera framing everything' if any(obj.type == 'CAMERA' for obj in temporary) else scene.camera.name,
            'seconds': round(time.time() - started, 2),
        }
    except Exception:
        return {'ok': False, 'error': traceback.format_exc(limit=6)}
    finally:
        scene.camera = saved['camera']
        for obj in temporary:
            data = obj.data
            bpy.data.objects.remove(obj, do_unlink=True)
            if isinstance(data, bpy.types.Camera):
                bpy.data.cameras.remove(data)
            elif isinstance(data, bpy.types.Light):
                bpy.data.lights.remove(data)
        try:
            render.engine = saved['engine']
        except TypeError:
            pass
        render.resolution_x, render.resolution_y, render.resolution_percentage = saved['x'], saved['y'], saved['percent']
        render.filepath = saved['filepath']
        render.image_settings.file_format = saved['format']
        if scene.frame_current != saved['frame']:
            scene.frame_set(saved['frame'])


def _round(vector):
    return [round(value, 3) for value in vector]


def op_scene(_request):
    scene = bpy.context.scene
    objects = []
    for obj in list(scene.objects)[:200]:
        action = obj.animation_data.action if obj.animation_data else None
        objects.append({
            'name': obj.name,
            'type': obj.type,
            'location': _round(obj.location),
            'rotation': _round(obj.rotation_euler),
            'scale': _round(obj.scale),
            'dimensions': _round(obj.dimensions),
            'parent': obj.parent.name if obj.parent else None,
            'materials': [slot.material.name for slot in getattr(obj, 'material_slots', []) if slot.material],
            'modifiers': [modifier.type for modifier in getattr(obj, 'modifiers', [])],
            'animation': action.name if action else None,
        })
    return {
        'ok': True,
        'scene': {
            'file': bpy.data.filepath or None,
            'unsaved': bool(bpy.data.is_dirty),
            'scene': scene.name,
            'engine': scene.render.engine,
            'frames': [scene.frame_start, scene.frame_end],
            'frame': scene.frame_current,
            'fps': scene.render.fps,
            'camera': scene.camera.name if scene.camera else None,
            'objects': objects,
            'objectCount': len(scene.objects),
            'materials': [material.name for material in bpy.data.materials][:100],
            'actions': [action.name for action in bpy.data.actions][:100],
        },
    }


def handle(request):
    op = request.get('op')
    if op == 'ping':
        return {'ok': True, 'version': bpy.app.version_string, 'background': BACKGROUND}
    if op == 'exec':
        return op_exec(request)
    if op == 'render':
        return op_render(request)
    if op == 'scene':
        return op_scene(request)
    if op == 'quit':
        STOP.set()
        return {'ok': True}
    return {'ok': False, 'error': 'unknown op ' + str(op)}


# --- transport ---------------------------------------------------------------
def _read_request(conn):
    conn.settimeout(10)
    data = b''
    while b'\n' not in data and len(data) < 16_000_000:
        chunk = conn.recv(65536)
        if not chunk:
            break
        data += chunk
    request = json.loads(data.split(b'\n', 1)[0].decode('utf-8'))
    if not isinstance(request, dict) or request.get('token') != TOKEN or not TOKEN:
        raise PermissionError('bad token')
    return request


def _reply(conn, reply):
    try:
        conn.sendall((json.dumps(reply) + '\n').encode('utf-8'))
    except OSError:
        pass
    finally:
        try:
            conn.close()
        except OSError:
            pass


def _accept(conn):
    try:
        return _read_request(conn)
    except Exception as error:
        _reply(conn, {'ok': False, 'error': 'refused: ' + str(error)})
        return None


def _quit_blender():
    try:
        bpy.ops.wm.quit_blender()
    except Exception:
        os._exit(0)


def _parent_alive():
    if PARENT <= 0:
        return True
    if os.name == 'nt':
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, PARENT)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(PARENT, 0)
        return True
    except OSError:
        return False


def _watch_parent():
    while not STOP.is_set():
        time.sleep(2)
        if not _parent_alive():
            STOP.set()
            time.sleep(15)  # the main thread quits; this is the backstop
            os._exit(0)


server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.bind(('127.0.0.1', PORT))
server.listen(8)
threading.Thread(target=_watch_parent, daemon=True).start()

if BACKGROUND:
    server.settimeout(1.0)
    while not STOP.is_set():
        try:
            conn, _ = server.accept()
        except socket.timeout:
            continue
        request = _accept(conn)
        if request is not None:
            _reply(conn, handle(request))
    server.close()
    # the script ends; blender -b exits
else:
    def _listen():
        while not STOP.is_set():
            try:
                conn, _ = server.accept()
            except OSError:
                return
            request = _accept(conn)
            if request is not None:
                REQUESTS.put((conn, request))

    def _drain():
        while True:
            try:
                conn, request = REQUESTS.get_nowait()
            except queue.Empty:
                break
            try:
                reply = handle(request)
            except Exception:
                reply = {'ok': False, 'error': traceback.format_exc(limit=6)}
            _reply(conn, reply)
        if STOP.is_set():
            try:
                server.close()
            except OSError:
                pass
            _quit_blender()
            return None
        return 0.1

    threading.Thread(target=_listen, daemon=True).start()
    bpy.app.timers.register(_drain, first_interval=0.1, persistent=True)
