import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.lwjgl.opengl.GL11;

/** Calls the installed model pose methods and captures meshes without running Minecraft. */
public final class NpcModelCapture {
    private static final Field BOX_FACES=field(aya.class,"i");
    private static final float UNIT=1f/16;
    private static final Map<ayf,Integer> geometry=new IdentityHashMap<ayf,Integer>();
    private static final List<ayf> byIndex=new ArrayList<ayf>();
    private static final List<String> frame=new ArrayList<String>();
    private static final Map<ayf,String> names=new IdentityHashMap<ayf,String>();

    private static Field field(Class<?> type,String name) {
        try {
            Field field=type.getDeclaredField(name);
            field.setAccessible(true);
            return field;
        } catch (ReflectiveOperationException error) {throw new IllegalStateException(error);}
    }
    private static void append(StringBuilder target,double n) {
        target.append('\t').append(Math.round(n*1000000.0)/1000000.0);
    }
    public static void part(ayf renderer,float scale) {
        if(renderer.l.isEmpty()) return;
        Integer index=geometry.get(renderer);
        if(index==null) {
            index=byIndex.size();
            geometry.put(renderer,index);
            byIndex.add(renderer);
        }
        StringBuilder line=new StringBuilder("part\t").append(index);
        float[] matrix=GL11.matrix();
        for(int j=0;j<4;j++) for(int i=0;i<3;i++) append(line,matrix[i+j*4]*(j==3?1:scale));
        append(line,GL11.color[3]);
        frame.add(line.toString());
    }
    private static void outputGeometry() throws Exception {
        for(int index=0;index<byIndex.size();index++) {
            ayf renderer=byIndex.get(index);
            System.out.println("mesh\t"+index+"\t"+names.getOrDefault(renderer,"part"+index));
            for(Object box:renderer.l) {
                if(!(box instanceof aya)) continue;
                for(axd face:(axd[])BOX_FACES.get(box)) {
                    StringBuilder line=new StringBuilder("quad");
                    for(axq v:face.a) {
                        append(line,v.a.c);append(line,v.a.d);append(line,v.a.e);
                        append(line,v.b);append(line,v.c);
                    }
                    System.out.println(line);
                }
            }
        }
    }
    private static axa model(String type,String argline) throws Exception {
        String[] argv=argline.isEmpty()?new String[0]:argline.split(",");
        List<Constructor<?>> constructors=new ArrayList<Constructor<?>>();
        Collections.addAll(constructors,Class.forName(type).getDeclaredConstructors());
        constructors.sort((a,b)->Integer.compare(a.getParameterCount(),b.getParameterCount()));
        for(Constructor<?> ctor:constructors) {
            Class<?>[] parameters=ctor.getParameterTypes();
            if(!argline.equals("?") && argv.length!=parameters.length) continue;
            Object[] args=new Object[parameters.length];
            boolean valid=true;
            for(int i=0;i<parameters.length;i++) {
                Class<?> parameter=parameters[i];
                String value=argline.equals("?")?"0":argv[i];
                if(parameter==int.class) args[i]=Integer.parseInt(value);
                else if(parameter==float.class) args[i]=Float.parseFloat(value);
                else if(parameter==double.class) args[i]=Double.parseDouble(value);
                else if(parameter==boolean.class) args[i]=value.equals("1");
                else {valid=false;break;}
            }
            if(!valid) continue;
            try {
                ctor.setAccessible(true);
                return (axa)ctor.newInstance(args);
            } catch (ReflectiveOperationException error) {
                if(!argline.equals("?")) throw error;
            }
        }
        throw new IllegalArgumentException("No model constructor "+type+" "+argline);
    }
    private static lq entity(String type) {
        if(type.isEmpty()) return null;
        try {
            Class<?> cls=Class.forName(type);
            for(Constructor<?> ctor:cls.getDeclaredConstructors())
                if(ctor.getParameterCount()==1 && ctor.getParameterTypes()[0].isAssignableFrom(yc.class)) {
                    ctor.setAccessible(true);
                    try {return (lq)ctor.newInstance(new Object[]{null});}
                    catch(ReflectiveOperationException e) {break;}
                }
            // Several render helpers dereference the entity but only read primitive state fields.
            Class<?> unsafeType=Class.forName("sun.misc.Unsafe");
            Object unsafe=field(unsafeType,"theUnsafe").get(null);
            return (lq)unsafeType.getMethod("allocateInstance",Class.class).invoke(unsafe,cls);
        } catch (ReflectiveOperationException | LinkageError ignored) {return null;}
    }
    private static void fieldNames(axa model) throws IllegalAccessException {
        for(Class<?> type=model.getClass();type!=axa.class;type=type.getSuperclass())
            for(Field field:type.getDeclaredFields()) {
                if(field.getType()==ayf.class || ayf.class.isAssignableFrom(field.getType())) {
                    field.setAccessible(true);
                    if(field.get(model) instanceof ayf) names.putIfAbsent((ayf)field.get(model),field.getName());
                } else if(field.getType().isArray() && ayf.class.isAssignableFrom(field.getType().getComponentType())) {
                    field.setAccessible(true);
                    ayf[] data=(ayf[])field.get(model);
                    if(data!=null) for(int i=0;i<data.length;i++)
                        if(data[i]!=null) names.putIfAbsent(data[i],field.getName()+i);
                }
            }
    }
    private static void animateFlag(axa model,String field,boolean active) {
        try { model.getClass().getField(field).setBoolean(model,active); }
        catch(ReflectiveOperationException ignored) {}
    }
    private static void entityFloat(lq entity,String name,float value) {
        try {entity.getClass().getField(name).setFloat(entity,value);}
        catch(ReflectiveOperationException ignored) {}
    }
    private static void animationState(lq entity,float age,String action) {
        if(entity==null) return;
        entity.ab=Math.round(age);
        try {entity.getClass().getField("innerRotation").setInt(entity,Math.round(age*10));}
        catch(ReflectiveOperationException ignored) {}
        if(entity instanceof pp || entity.getClass().getSimpleName().equals("EntityNpcDragon")) {
            for(String name:new String[]{"bM","bN","field_40173_aw","field_40172_ax"})
                entityFloat(entity,name,age/24);
        }
        if(entity instanceof ow) ((ow)entity).f(false);
        try {entity.getClass().getMethod("setIsFlying",boolean.class).invoke(entity,action.equals("fly")||action.equals("idle"));}
        catch(ReflectiveOperationException ignored) {}
    }
    private static void transform(axa model,lq entity,float step,float amount,float age,float pitch,String action) {
        animationState(entity,age,action);
        model.q=action.equals("sit");
        model.s=false;
        model.p=action.equals("attack")?Math.max(.001f,age/24):0;
        animateFlag(model,"isSleeping",action.equals("crawl"));
        animateFlag(model,"isDancing",action.equals("dance"));
        animateFlag(model,"isSneak",action.equals("sneak"));
        animateFlag(model,"isFlying",action.equals("fly"));
        animateFlag(model,"isPegasus",action.equals("fly"));
        if(entity instanceof md) {
            try {model.a((md)entity,step,amount,.5f);}
            catch(RuntimeException | LinkageError ignored) {}
        }
        model.a(entity,step,amount,age,0,pitch,UNIT);
    }
    private static void direct(axa model,lq entity,float step,float amount,float age,float pitch) throws Exception {
        Method custom=null;
        try {custom=model.getClass().getMethod("setRotationAngles",float.class,float.class,float.class,float.class,float.class,float.class);}
        catch(NoSuchMethodException ignored) {}
        if(custom!=null) custom.invoke(model,step,amount,age,0,pitch,UNIT);
        else {
            try {model.a(step,amount,age,0,pitch,UNIT,entity);}
            catch(RuntimeException | LinkageError ignored) {}
        }
        Set<ayf> children=Collections.newSetFromMap(new IdentityHashMap<ayf,Boolean>());
        for(Object row:model.r) if(row instanceof ayf && ((ayf)row).m!=null) children.addAll(((ayf)row).m);
        for(Object row:model.r) if(row instanceof ayf && !children.contains(row)) ((ayf)row).a(UNIT);
    }
    private static boolean captureFrame(axa model,lq entity,String action,int frameNumber,int total,
                                        boolean nativeRender) throws Exception {
        GL11.reset();
        frame.clear();
        float step=(float)(frameNumber*Math.PI*2/.6662/total);
        float age=frameNumber*24f/total;
        float amount=action.equals("walk")||action.equals("fly")?.82f:0;
        float pitch=action.equals("look")?35:0;
        if(nativeRender) transform(model,entity,step,amount,age,pitch,action);
        else direct(model,entity,step,amount,age,pitch);
        if(frame.isEmpty()) return false;
        System.out.println("frame\t"+action+"\t"+frameNumber);
        for(String line:frame) System.out.println(line);
        return true;
    }
    private static void capture(String[] data) throws Exception {
        geometry.clear();byIndex.clear();names.clear();
        axa model=model(data[1],data[2]);
        lq entity=entity(data[3]);
        fieldNames(model);
        GL11.reset(); frame.clear();
        boolean nativeRender;
        try {
            transform(model,entity,0,0,0,0,"idle");
            nativeRender=!frame.isEmpty();
        } catch(RuntimeException | LinkageError error) {nativeRender=false;}
        System.out.println("model\t"+data[0]+"\t"+(nativeRender?"native":"parts"));
        for(String action:new String[]{"idle","walk","sit","crawl","sneak","dance","attack","fly","look"}) {
            int count=action.equals("look")||action.equals("sit")||action.equals("crawl")||action.equals("sneak")?1:8;
            for(int i=0;i<count;i++) {
                try {captureFrame(model,entity,action,i,count,nativeRender);}
                catch(RuntimeException | LinkageError error) {
                    try {captureFrame(model,entity,action,i,count,false);}
                    catch (RuntimeException | LinkageError fallback) {break;}
                }
            }
        }
        outputGeometry();
        System.out.println("end");
    }
    public static void main(String[] args) throws Exception {
        for(String line:Files.readAllLines(Paths.get(args[0]),StandardCharsets.UTF_8)) {
            if(line.isEmpty()) continue;
            String[] data=line.split("\\t",-1);
            try {capture(data);}
            catch(Throwable error) {System.err.println(data[0]+"\t"+error);error.printStackTrace(System.err);}
        }
    }
}
