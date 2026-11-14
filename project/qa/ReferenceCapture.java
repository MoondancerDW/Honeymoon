import java.awt.Canvas;
import java.awt.Dimension;
import java.awt.EventQueue;
import java.awt.Window;
import java.io.File;
import java.io.BufferedWriter;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.ProtectionDomain;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

public final class ReferenceCapture {
    private static List<String> poses;
    private static volatile List<String> walk;
    private static BufferedWriter walkLog;
    private static int walkIndex, walked, rejected, missing;
    private static double[] previous;
    private static long chunkRequested;
    private static final Map<String, int[]> openedDoors = new LinkedHashMap<String, int[]>();
    private static final double[] PLAYER_EDGES = {-.31, .31};
    private static long settleMs = 1800;
    private static boolean serverWalk;
    private static Object serverPlayer, serverWorld;
    private static volatile double[] pendingTeleport;
    private static volatile int[] pendingInteraction;
    private static File output;
    private static int index;
    private static long since, worldReady;
    private static boolean requestedWorld, sized;
    private static volatile boolean failed;
    private static Method place, screenshot, gui;
    private static Field player, world, screen, camera, gameSettings, hidden, width, height, canvas;
    private static Field previousYaw, previousPitch, offset, speedX, speedY, speedZ;
    private static Method setClientTime, setRain, setMetadata, getChunk, blockMetadata;
    private static volatile Method move;
    private static Method travel, onLadder;
    private static Field boundingBox, minY, px, pz, grounded, stepHeight, stepOffset;

    public static void premain(String options, Instrumentation inst) throws Exception {
        javax.imageio.ImageIO.setUseCache(false);
        String[] values = options.split(",", 5);
        poses = Files.readAllLines(Paths.get(values[0]), StandardCharsets.UTF_8);
        output = new File(values[1]);
        Files.createDirectories(output.toPath().resolve("screenshots"));
        if (values.length > 2 && !values[2].isEmpty()) {
            walk = Files.readAllLines(Paths.get(values[2]), StandardCharsets.UTF_8);
            walkLog = Files.newBufferedWriter(output.toPath().resolve("walk-result.tsv"), StandardCharsets.UTF_8);
            walkLog.write("line\tstatus\tx\ty\tz\tactualX\tactualY\tactualZ\n");
        }
        if (values.length > 3) settleMs = Long.parseLong(values[3]);
        serverWalk = values.length > 4 && "server".equals(values[4]);
        inst.addTransformer(new ClassFileTransformer() {
            @Override public byte[] transform(ClassLoader loader, String name, Class<?> type,
                    ProtectionDomain domain, byte[] bytes) {
                boolean integrated = "net/minecraft/server/MinecraftServer".equals(name);
                if (!integrated && !"net/minecraft/client/Minecraft".equals(name)) return null;
                ClassReader input = new ClassReader(bytes);
                ClassWriter result = new ClassWriter(input, ClassWriter.COMPUTE_MAXS);
                input.accept(new ClassVisitor(Opcodes.ASM4, result) {
                    @Override public MethodVisitor visitMethod(int access, String method, String desc,
                            String signature, String[] exceptions) {
                        MethodVisitor delegate = super.visitMethod(access, method, desc, signature, exceptions);
                        if (integrated) {
                            if (!"q".equals(method) || !"()V".equals(desc)) return delegate;
                            return new MethodVisitor(Opcodes.ASM4, delegate) {
                                @Override public void visitCode() {
                                    super.visitCode();
                                    super.visitVarInsn(Opcodes.ALOAD, 0);
                                    super.visitMethodInsn(Opcodes.INVOKESTATIC, "ReferenceCapture", "onServerTick", "(Ljava/lang/Object;)V");
                                }
                            };
                        }
                        if (!"J".equals(method) || !"()V".equals(desc)) return delegate;
                        return new MethodVisitor(Opcodes.ASM4, delegate) {
                            @Override public void visitMethodInsn(int op, String owner, String method, String desc) {
                                if (op == Opcodes.INVOKEVIRTUAL && "ban".equals(owner) && "b".equals(method) && "(F)V".equals(desc)) {
                                    super.visitVarInsn(Opcodes.ALOAD, 0);
                                    super.visitMethodInsn(Opcodes.INVOKESTATIC, "ReferenceCapture", "before", "(Ljava/lang/Object;)V");
                                    super.visitMethodInsn(op, owner, method, desc);
                                    super.visitVarInsn(Opcodes.ALOAD, 0);
                                    super.visitMethodInsn(Opcodes.INVOKESTATIC, "ReferenceCapture", "after", "(Ljava/lang/Object;)V");
                                    return;
                                }
                                super.visitMethodInsn(op, owner, method, desc);
                            }
                        };
                    }
                }, 0);
                return result.toByteArray();
            }
        });
    }

    private static Method systemBefore, systemAfter, systemServerTick;
    private static void forward(String phase, Object mc) {
        if (failed) return;
        try {
            if (systemBefore == null) {
                Class<?> host = Class.forName("ReferenceCapture", true, ClassLoader.getSystemClassLoader());
                if (host == ReferenceCapture.class) throw new IllegalStateException("System capture agent has no poses");
                systemBefore = host.getMethod("before", Object.class);
                systemAfter = host.getMethod("after", Object.class);
                systemServerTick = host.getMethod("onServerTick", Object.class);
            }
            ("before".equals(phase) ? systemBefore : "after".equals(phase) ? systemAfter : systemServerTick).invoke(null, mc);
        } catch (Throwable error) {
            failed = true;
            error.printStackTrace();
        }
    }

    private static void bind(Object mc) throws Exception {
        ClassLoader loader = mc.getClass().getClassLoader();
        Class<?> minecraft = Class.forName("net.minecraft.client.Minecraft", false, loader);
        Class<?> entity = Class.forName("lq", false, loader);
        player = minecraft.getField("g");
        world = minecraft.getField("e");
        screen = minecraft.getField("r");
        camera = minecraft.getField("h");
        gameSettings = minecraft.getField("y");
        width = minecraft.getField("c");
        height = minecraft.getField("d");
        canvas = minecraft.getField("l");
        hidden = gameSettings.getType().getField("V");
        place = entity.getMethod("b", double.class, double.class, double.class, float.class, float.class);
        previousYaw = entity.getField("B");
        previousPitch = entity.getField("C");
        offset = entity.getField("M");
        speedX = entity.getField("w");
        speedY = entity.getField("x");
        speedZ = entity.getField("y");
        gui = minecraft.getMethod("a", screen.getType());
        screenshot = Class.forName("asx", false, loader).getMethod("a", File.class, String.class, int.class, int.class);
        setClientTime = world.getType().getMethod("b", long.class);
        setRain = world.getType().getMethod("k", float.class);
        setMetadata = world.getType().getMethod("c", int.class, int.class, int.class, int.class);
        blockMetadata = world.getType().getMethod("h", int.class, int.class, int.class);
        getChunk = world.getType().getMethod("e", int.class, int.class);
        boundingBox = entity.getField("D");
        minY = boundingBox.getType().getField("b");
        px = entity.getField("t");
        pz = entity.getField("v");
        grounded = entity.getField("E");
        stepHeight = entity.getField("X");
        stepOffset = entity.getField("W");
        move = entity.getMethod("d", double.class, double.class, double.class);
        Class<?> living = Class.forName("md", false, loader);
        travel = living.getMethod("e", float.class, float.class);
        onLadder = living.getMethod("g_");
    }

    public static void before(Object mc) {
        if (poses == null) { forward("before", mc); return; }
        if (failed || (walk == null && index >= poses.size())) return;
        try {
            if (player == null) bind(mc);
            if (!sized) {
                sized = true;
                final Canvas target = (Canvas) canvas.get(mc);
                if (target != null) EventQueue.invokeLater(new Runnable() {
                    public void run() {
                        for (java.awt.Component parent = target; parent != null; parent = parent.getParent()) {
                            if (parent instanceof Window) {
                                Dimension initial = target.getSize();
                                parent.setSize(parent.getWidth() + 1280 - initial.width,
                                        parent.getHeight() + 720 - initial.height);
                                return;
                            }
                        }
                    }
                });
            }
            Object currentWorld = world.get(mc);
            if (!requestedWorld && currentWorld == null && screen.get(mc) != null &&
                    "bey".equals(screen.get(mc).getClass().getName())) {
                requestedWorld = true;
                Method start = world.getDeclaringClass().getMethod("a", String.class, String.class,
                        Class.forName("yk", false, mc.getClass().getClassLoader()));
                start.invoke(mc, "equestria", "Equestria", null);
                System.out.println("[reference] Requested original world");
                return;
            }
            Object localPlayer = player.get(mc);
            if (currentWorld == null || localPlayer == null) return;
            long now = System.currentTimeMillis();
            if (worldReady == 0) {
                worldReady = now;
                System.out.println("[reference] World joined");
            }
            if (now - worldReady < (walk == null ? 3200 : 9000)) return;
            setClientTime.invoke(currentWorld, 6000L);
            setRain.invoke(currentWorld, 0.0f);
            if (screen.get(mc) != null) gui.invoke(mc, new Object[] {null});
            hidden.setBoolean(gameSettings.get(mc), true);
            if (walk != null) {
                if (!serverWalk) replay(currentWorld, localPlayer, now);
                return;
            }
            if (index >= poses.size()) return;
            String[] pose = poses.get(index).trim().split("\\s+");
            double x = Double.parseDouble(pose[1]);
            double y = Double.parseDouble(pose[2]);
            double z = Double.parseDouble(pose[3]);
            float yaw = Float.parseFloat(pose[4]);
            float pitch = Float.parseFloat(pose[5]);
            if (since == 0) {
                if (pose.length == 9) pendingInteraction = new int[] {Integer.parseInt(pose[6]), Integer.parseInt(pose[7]), Integer.parseInt(pose[8])};
                pendingTeleport = new double[] {x, y, z};
            }
            place.invoke(localPlayer, x, y, z, yaw, pitch);
            previousYaw.setFloat(localPlayer, yaw);
            previousPitch.setFloat(localPlayer, pitch);
            speedX.setDouble(localPlayer, 0);
            speedY.setDouble(localPlayer, 0);
            speedZ.setDouble(localPlayer, 0);
            camera.set(mc, localPlayer);
            if (since == 0) {
                since = now;
                System.out.println("[reference] Pose " + poses.get(index) + " offset=" + offset.getFloat(localPlayer) + " size=" + width.getInt(mc) + "x" + height.getInt(mc));
            }
        } catch (Throwable error) {
            failed = true;
            error.printStackTrace();
        }
    }

    public static void onServerTick(Object server) {
        if (poses == null) { forward("server", server); return; }
        if (failed || move == null || (pendingTeleport == null && pendingInteraction == null && (!serverWalk || walk == null))) return;
        try {
            Object players = server.getClass().getMethod("ad").invoke(server);
            if (serverPlayer == null) {
                serverPlayer = players.getClass().getMethod("f", String.class).invoke(players, "HoneymoonQA");
                if (serverPlayer == null) return;
                serverWorld = serverPlayer.getClass().getMethod("p").invoke(serverPlayer);
            }
            double[] destination = pendingTeleport;
            if (destination != null) {
                Class<?> handlerType = Class.forName("iv", false, serverPlayer.getClass().getClassLoader());
                Object handler = null;
                for (Field field : serverPlayer.getClass().getFields()) {
                    if (handlerType.isAssignableFrom(field.getType())) { handler = field.get(serverPlayer); break; }
                }
                if (handler == null) return;
                handler.getClass().getMethod("a", double.class, double.class, double.class, float.class, float.class)
                        .invoke(handler, destination[0], destination[1], destination[2], 0.0f, 0.0f);
                players.getClass().getMethod("d", serverPlayer.getClass()).invoke(players, serverPlayer);
                pendingTeleport = null;
            }
            int[] interaction = pendingInteraction;
            if (interaction != null && System.currentTimeMillis() - since >= 600) {
                int x = interaction[0], y = interaction[1], z = interaction[2];
                ClassLoader loader = serverPlayer.getClass().getClassLoader();
                Method idAt = serverWorld.getClass().getMethod("a", int.class, int.class, int.class);
                int before = (Integer) idAt.invoke(serverWorld, x, y, z);
                Class<?> blockClass = loader.loadClass("amq");
                Object block = ((Object[]) blockClass.getField("p").get(null))[before];
                Method activate = blockClass.getMethod("a", loader.loadClass("yc"), int.class, int.class, int.class,
                        loader.loadClass("qx"), int.class, float.class, float.class, float.class);
                Object handled = activate.invoke(block, serverWorld, x, y, z, serverPlayer, 1, .5f, .5f, .5f);
                serverWorld.getClass().getMethod("z", int.class, int.class, int.class).invoke(serverWorld, x, y, z);
                System.out.println("[reference] Block interaction " + x + " " + y + " " + z + ": " + before + " -> "
                        + idAt.invoke(serverWorld, x, y, z) + ", accepted=" + handled);
                pendingInteraction = null;
            }
            if (!serverWalk || walk == null) return;
            if (walkIndex == 0) {
                Object provider = serverWorld.getClass().getField("b").get(serverWorld);
                Method load = provider.getClass().getMethod("c", int.class, int.class);
                Map<String, int[]> chunks = new LinkedHashMap<String, int[]>();
                for (String row : walk) {
                    String[] fields = row.trim().split("\\s+");
                    double x = Double.parseDouble(fields[1]), z = Double.parseDouble(fields[3]);
                    for (double dx : PLAYER_EDGES) for (double dz : PLAYER_EDGES) {
                        int cx = ((int) Math.floor(x + dx)) >> 4, cz = ((int) Math.floor(z + dz)) >> 4;
                        chunks.put(cx + "," + cz, new int[] {cx, cz});
                    }
                }
                for (int[] chunk : chunks.values()) load.invoke(provider, chunk[0], chunk[1]);
                System.out.println("[reference] Loaded " + chunks.size() + " original chunks for native collisions");
            }
            replay(serverWorld, serverPlayer, System.currentTimeMillis());
        } catch (Throwable error) {
            failed = true;
            error.printStackTrace();
        }
    }

    private static void replay(Object currentWorld, Object localPlayer, long now) throws Exception {
        int budget = serverWalk ? 2000 : 180;
        for (int batch = 0; batch < budget && walkIndex < walk.size(); batch++, walkIndex++) {
            String[] fields = walk.get(walkIndex).trim().split("\\s+");
            double x = Double.parseDouble(fields[1]);
            double y = Double.parseDouble(fields[2]);
            double z = Double.parseDouble(fields[3]);
            if ("r".equals(fields[0])) {
                previous = new double[] {x, y, z};
                continue;
            }
            boolean loaded = loaded(currentWorld, x, z);
            if ("c".equals(fields[0])) {
                if (!serverWalk || !loaded) throw new IllegalStateException("Climb probe requires a loaded server chunk");
                probeClimb(localPlayer, x, y, z, Float.parseFloat(fields[4]), Double.parseDouble(fields[5]));
                continue;
            }
            if (!serverWalk && !loaded && chunkRequested == 0) {
                pendingTeleport = new double[] {x, y, z};
                chunkRequested = now;
                return;
            }
            if (!serverWalk && !loaded && now - chunkRequested < 6000) return;
            if (chunkRequested != 0) {
                for (int[] door : openedDoors.values()) {
                    if (loaded(currentWorld, door[0] + .5, door[2] + .5)) applyDoor(currentWorld, door);
                }
                chunkRequested = 0;
            }
            if ("d".equals(fields[0])) {
                int target = Integer.parseInt(fields[4]);
                int[] door = {(int) x, (int) y, (int) z, target};
                openedDoors.put(fields[1] + " " + fields[2] + " " + fields[3], door);
                if (loaded) applyDoor(currentWorld, door);
                int actual = (Integer) blockMetadata.invoke(currentWorld, (int) x, (int) y, (int) z);
                if (actual != target) walkLog.write(walkIndex + "\tdoor\t" + x + "\t" + y + "\t" + z + "\t" + actual + "\t" + target + "\t0\n");
                continue;
            }
            if (previous == null) {
                previous = new double[] {x, y, z};
                continue;
            }
            String status = "pass";
            double actualX = x, actualY = y, actualZ = z;
            if (!loaded) {
                status = "unloaded";
                missing++;
            } else {
                double dx = x - previous[0], dz = z - previous[2];
                float yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
                boolean sampled = "m".equals(fields[0]);
                stepOffset.setFloat(localPlayer, 0.0f);
                stepHeight.setFloat(localPlayer, sampled ? 0.0f : .5f);
                place.invoke(localPlayer, previous[0], previous[1], previous[2], yaw, 0.0f);
                grounded.setBoolean(localPlayer, true);
                move.invoke(localPlayer, dx, sampled ? y - previous[1] : -0.001, dz);
                if (!sampled) move.invoke(localPlayer, 0.0, -0.5, 0.0);
                actualX = px.getDouble(localPlayer);
                actualY = minY.getDouble(boundingBox.get(localPlayer));
                actualZ = pz.getDouble(localPlayer);
                if (Math.abs(actualX - x) > .025 || Math.abs(actualY - y) > .025 || Math.abs(actualZ - z) > .025) {
                    status = "different";
                    rejected++;
                } else walked++;
            }
            if (!"pass".equals(status)) walkLog.write(walkIndex + "\t" + status + "\t" + x + "\t" + y + "\t" + z
                    + "\t" + actualX + "\t" + actualY + "\t" + actualZ + "\n");
            previous = new double[] {x, y, z};
        }
        if (walkIndex == walk.size()) {
            walkLog.close();
            String totals = "pass=" + walked + " different=" + rejected + " unloaded=" + missing;
            Files.write(output.toPath().resolve("walk-complete.txt"), (totals + "\n").getBytes(StandardCharsets.UTF_8));
            System.out.println("[reference] Native movement " + totals);
            walk = null;
        }
    }

    private static void probeClimb(Object player, double x, double y, double z, float yaw, double upward) throws Exception {
        stepOffset.setFloat(player, 0);
        stepHeight.setFloat(player, .5f);
        place.invoke(player, x, y, z, yaw, 0.0f);
        speedX.setDouble(player, 0);
        speedY.setDouble(player, upward);
        speedZ.setDouble(player, 0);
        grounded.setBoolean(player, false);
        boolean beganOnLadder = (Boolean) onLadder.invoke(player);
        double maxY = y;
        for (int tick = 0; tick < 46; tick++) {
            travel.invoke(player, 0.0f, .98f);
            maxY = Math.max(maxY, minY.getDouble(boundingBox.get(player)));
        }
        System.out.printf(java.util.Locale.ROOT, "[climb-probe] %.3f %.3f %.3f %.0f %s %.6f %.6f %.6f %.6f%n",
                x, y, z, yaw, beganOnLadder, maxY, px.getDouble(player), minY.getDouble(boundingBox.get(player)), pz.getDouble(player));
    }

    private static void applyDoor(Object currentWorld, int[] door) throws Exception {
        setMetadata.invoke(currentWorld, door[0], door[1], door[2], door[3]);
    }

    private static boolean loaded(Object currentWorld, double x, double z) throws Exception {
        for (double dx : PLAYER_EDGES) {
            for (double dz : PLAYER_EDGES) {
                Object chunk = getChunk.invoke(currentWorld, ((int) Math.floor(x + dx)) >> 4,
                        ((int) Math.floor(z + dz)) >> 4);
                if (!"zz".equals(chunk.getClass().getName())) return false;
            }
        }
        return true;
    }

    public static void after(Object mc) {
        if (poses == null) { forward("after", mc); return; }
        if (failed || since == 0 || index >= poses.size() || System.currentTimeMillis() - since < settleMs) return;
        try {
            if (pendingTeleport != null || pendingInteraction != null || world.get(mc) == null || screen.get(mc) != null) return;
            String name = poses.get(index).trim().split("\\s+")[0] + ".png";
            System.out.println("[reference] " + screenshot.invoke(null, output, name, width.getInt(mc), height.getInt(mc)));
            index++;
            since = 0;
            if (index == poses.size()) {
                Files.write(output.toPath().resolve("complete.txt"), "completed\n".getBytes(StandardCharsets.UTF_8));
                System.out.println("[reference] Captured " + index + " poses.");
            }
        } catch (Throwable error) {
            failed = true;
            error.printStackTrace();
        }
    }
}
